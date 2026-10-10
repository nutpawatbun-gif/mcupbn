import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { createDefaultSharePackage, DEFAULT_FILES } from './src/data/defaultDriveFolder.ts';
import { SharePackage, DriveFileItem } from './src/types/share.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// In-memory database with local storage backup
const DATA_FILE = path.join(__dirname, '.shares-data.json');
let shares: Record<string, SharePackage> = {};

// Load persisted data or initialize default
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    shares = JSON.parse(raw);
  }
} catch (e) {
  console.warn('Could not read saved data, using default:', e);
}

// Ensure default package is always available
if (!shares['grade-sem1-2569']) {
  const defaultPkg = createDefaultSharePackage();
  shares[defaultPkg.id] = defaultPkg;
  saveSharesData();
}

function saveSharesData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(shares, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write shares data:', err);
  }
}

// Helper: check expiration
function isShareExpired(pkg: SharePackage): boolean {
  if (!pkg.security.expiresAt) return false;
  return new Date() > new Date(pkg.security.expiresAt);
}

// Helper: check download limit
function isDownloadLimitReached(pkg: SharePackage): boolean {
  if (pkg.security.maxDownloads === null || pkg.security.maxDownloads === undefined) return false;
  return pkg.stats.totalDownloadsCount >= pkg.security.maxDownloads;
}

// --- API ROUTES ---

// 1. Get all shares (Admin view / list)
app.get('/api/shares', (req: Request, res: Response) => {
  const list = Object.values(shares).map((pkg) => ({
    id: pkg.id,
    title: pkg.title,
    description: pkg.description,
    sourceDriveUrl: pkg.sourceDriveUrl,
    fileCount: pkg.files.length,
    createdAt: pkg.createdAt,
    security: {
      requirePassword: pkg.security.requirePassword,
      password: pkg.security.password, // Admin can view
      passwordHint: pkg.security.passwordHint,
      expiresAt: pkg.security.expiresAt,
      maxDownloads: pkg.security.maxDownloads,
      allowPreviewWithoutDownload: pkg.security.allowPreviewWithoutDownload,
      allowZipDownload: pkg.security.allowZipDownload,
    },
    stats: pkg.stats,
    isExpired: isShareExpired(pkg),
    isLimitReached: isDownloadLimitReached(pkg),
    customNote: pkg.customNote,
  }));
  res.json({ success: true, data: list });
});

// 2. Get public metadata for a specific share link
app.get('/api/shares/:id', (req: Request, res: Response) => {
  const pkg = shares[req.params.id];
  if (!pkg) {
    return res.status(404).json({ success: false, message: 'ไม่พบลิงก์แชร์นี้ในระบบ' });
  }

  // Increment view count
  pkg.stats.viewsCount += 1;
  pkg.stats.lastAccessedAt = new Date().toISOString();
  saveSharesData();

  const isExpired = isShareExpired(pkg);
  const isLimitReached = isDownloadLimitReached(pkg);

  // Return public info (Do not reveal plain password or file download links yet if locked)
  res.json({
    success: true,
    data: {
      id: pkg.id,
      title: pkg.title,
      description: pkg.description,
      sourceDriveUrl: pkg.sourceDriveUrl,
      fileCount: pkg.files.length,
      createdAt: pkg.createdAt,
      security: {
        requirePassword: pkg.security.requirePassword,
        passwordHint: pkg.security.passwordHint,
        expiresAt: pkg.security.expiresAt,
        maxDownloads: pkg.security.maxDownloads,
        allowPreviewWithoutDownload: pkg.security.allowPreviewWithoutDownload,
        allowZipDownload: pkg.security.allowZipDownload,
      },
      stats: {
        viewsCount: pkg.stats.viewsCount,
        unlockedCount: pkg.stats.unlockedCount,
        totalDownloadsCount: pkg.stats.totalDownloadsCount,
        lastAccessedAt: pkg.stats.lastAccessedAt,
      },
      isExpired,
      isLimitReached,
      customNote: pkg.customNote,
    },
  });
});

// 3. Unlock share with password
app.post('/api/shares/:id/unlock', (req: Request, res: Response) => {
  const pkg = shares[req.params.id];
  if (!pkg) {
    return res.status(404).json({ success: false, message: 'ไม่พบลิงก์แชร์นี้' });
  }

  if (isShareExpired(pkg)) {
    return res.status(403).json({
      success: false,
      isExpired: true,
      message: 'ลิงก์นี้หมดอายุการใช้งานแล้ว ไม่สามารถเข้าถึงได้',
    });
  }

  const { password } = req.body;

  if (pkg.security.requirePassword) {
    const expected = (pkg.security.password || '').trim().toLowerCase();
    const provided = (password || '').toString().trim().toLowerCase();

    if (provided !== expected) {
      return res.status(401).json({
        success: false,
        message: 'รหัสผ่านไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง',
        hint: pkg.security.passwordHint,
      });
    }
  }

  // Unlocked successfully
  pkg.stats.unlockedCount += 1;
  saveSharesData();

  // Return full package with files
  res.json({
    success: true,
    message: 'ปลดล็อกการเข้าถึงไฟล์สำเร็จ',
    data: {
      ...pkg,
      isExpired: false,
      isLimitReached: isDownloadLimitReached(pkg),
    },
  });
});

// 4. Download file endpoint (validates expiry & download limit, increments count)
app.get('/api/shares/:id/download/:fileId', async (req: Request, res: Response) => {
  const pkg = shares[req.params.id];
  if (!pkg) {
    return res.status(404).send('ไม่พบลิงก์แชร์');
  }

  if (isShareExpired(pkg)) {
    return res.status(403).send('ลิงก์นี้หมดอายุการใช้งานแล้ว');
  }

  if (isDownloadLimitReached(pkg)) {
    return res.status(403).send('สิทธิ์การดาวน์โหลดสำหรับลิงก์นี้ครบตามจำนวนที่กำหนดแล้ว');
  }

  const file = pkg.files.find((f) => f.id === req.params.fileId);
  if (!file) {
    return res.status(404).send('ไม่พบไฟล์ที่ต้องการ');
  }

  // Increment download counts
  pkg.stats.totalDownloadsCount += 1;
  file.downloadCount = (file.downloadCount || 0) + 1;
  file.lastDownloadedAt = new Date().toISOString();
  saveSharesData();

  // Redirect directly to Google Drive download stream URL or stream it
  const downloadUrl = `https://drive.usercontent.google.com/download?id=${file.id}&export=download`;
  res.redirect(302, downloadUrl);
});

// 5. Proxy file stream (useful for frontend ZIP bundling without CORS issues)
app.get('/api/shares/:id/file-stream/:fileId', (req: Request, res: Response) => {
  const pkg = shares[req.params.id];
  if (!pkg) return res.status(404).send('Not found');

  if (isShareExpired(pkg)) return res.status(403).send('Expired');
  if (isDownloadLimitReached(pkg)) return res.status(403).send('Limit reached');

  const file = pkg.files.find((f) => f.id === req.params.fileId);
  if (!file) return res.status(404).send('File not found');

  // Increment count
  pkg.stats.totalDownloadsCount += 1;
  file.downloadCount = (file.downloadCount || 0) + 1;
  saveSharesData();

  const directUrl = `https://drive.google.com/uc?export=download&id=${file.id}`;

  https.get(directUrl, (gRes) => {
    const redirectUrl = gRes.headers.location;
    if (redirectUrl) {
      https.get(redirectUrl, (gRes2) => {
        res.setHeader('Content-Type', file.mimeType || 'application/vnd.ms-excel');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        gRes2.pipe(res);
      }).on('error', (err) => {
        res.status(500).send('Download stream error: ' + err.message);
      });
    } else {
      res.setHeader('Content-Type', file.mimeType || 'application/vnd.ms-excel');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      gRes.pipe(res);
    }
  }).on('error', (err) => {
    res.status(500).send('Google Drive fetch error: ' + err.message);
  });
});

// 6. Record download count (called when client initiates direct download or zip)
app.post('/api/shares/:id/record-download', (req: Request, res: Response) => {
  const pkg = shares[req.params.id];
  if (!pkg) {
    return res.status(404).json({ success: false, message: 'ไม่พบลิงก์แชร์' });
  }

  if (isShareExpired(pkg)) {
    return res.status(403).json({ success: false, message: 'ลิงก์นี้หมดอายุแล้ว' });
  }

  if (isDownloadLimitReached(pkg)) {
    return res.status(403).json({ success: false, message: 'จำนวนครั้งในการดาวน์โหลดครบแล้ว' });
  }

  const { fileId, count = 1 } = req.body;
  pkg.stats.totalDownloadsCount += count;

  if (fileId) {
    const file = pkg.files.find((f) => f.id === fileId);
    if (file) {
      file.downloadCount = (file.downloadCount || 0) + 1;
      file.lastDownloadedAt = new Date().toISOString();
    }
  }

  saveSharesData();

  const remaining =
    pkg.security.maxDownloads !== null && pkg.security.maxDownloads !== undefined
      ? Math.max(0, pkg.security.maxDownloads - pkg.stats.totalDownloadsCount)
      : null;

  res.json({
    success: true,
    totalDownloadsCount: pkg.stats.totalDownloadsCount,
    remainingDownloads: remaining,
    isLimitReached: isDownloadLimitReached(pkg),
  });
});

// 7. Create new share link
app.post('/api/shares', (req: Request, res: Response) => {
  const {
    title,
    description,
    sourceDriveUrl,
    password,
    passwordHint,
    expiresInHours,
    customExpiresAt,
    maxDownloads,
    customNote,
    files,
  } = req.body;

  if (!title) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อชุดไฟล์ที่ต้องการแชร์' });
  }

  // Generate ID
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const id = `share-${randomSuffix}`;

  // Calculate expiry
  let expiresAt: string | null = null;
  if (customExpiresAt) {
    expiresAt = new Date(customExpiresAt).toISOString();
  } else if (expiresInHours && expiresInHours > 0) {
    expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
  }

  const finalFiles: DriveFileItem[] =
    files && files.length > 0 ? files : DEFAULT_FILES;

  const newShare: SharePackage = {
    id,
    title: title.trim(),
    description: description || '',
    sourceDriveUrl: sourceDriveUrl || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    customNote: customNote || '',
    security: {
      requirePassword: Boolean(password && password.trim().length > 0),
      password: password ? password.trim() : '',
      passwordHint: passwordHint || '',
      expiresAt,
      maxDownloads: maxDownloads !== undefined && maxDownloads !== null && maxDownloads > 0 ? Number(maxDownloads) : null,
      allowPreviewWithoutDownload: true,
      allowZipDownload: true,
    },
    files: finalFiles,
    stats: {
      viewsCount: 0,
      unlockedCount: 0,
      totalDownloadsCount: 0,
      lastAccessedAt: null,
    },
  };

  shares[id] = newShare;
  saveSharesData();

  res.json({
    success: true,
    message: 'สร้างลิงก์แชร์ที่มีการป้องกันสำเร็จ',
    data: newShare,
  });
});

// 8. Update / extend existing share link
app.patch('/api/shares/:id', (req: Request, res: Response) => {
  const pkg = shares[req.params.id];
  if (!pkg) {
    return res.status(404).json({ success: false, message: 'ไม่พบลิงก์แชร์' });
  }

  const {
    password,
    passwordHint,
    expiresAt,
    maxDownloads,
    resetDownloads,
    customNote,
    title,
  } = req.body;

  if (title) pkg.title = title;
  if (password !== undefined) {
    pkg.security.password = password;
    pkg.security.requirePassword = Boolean(password && password.trim().length > 0);
  }
  if (passwordHint !== undefined) pkg.security.passwordHint = passwordHint;
  if (expiresAt !== undefined) pkg.security.expiresAt = expiresAt;
  if (maxDownloads !== undefined) pkg.security.maxDownloads = maxDownloads;
  if (customNote !== undefined) pkg.customNote = customNote;

  if (resetDownloads) {
    pkg.stats.totalDownloadsCount = 0;
    pkg.files.forEach((f) => (f.downloadCount = 0));
  }

  pkg.updatedAt = new Date().toISOString();
  saveSharesData();

  res.json({ success: true, message: 'บันทึกการตั้งค่าสำเร็จ', data: pkg });
});

// 9. Delete / revoke share link
app.delete('/api/shares/:id', (req: Request, res: Response) => {
  if (req.params.id === 'grade-sem1-2569') {
    // Re-initialize default instead of complete deletion
    shares['grade-sem1-2569'] = createDefaultSharePackage();
    saveSharesData();
    return res.json({ success: true, message: 'รีเซ็ตลิงก์ค่าเริ่มต้นสำเร็จ' });
  }

  delete shares[req.params.id];
  saveSharesData();
  res.json({ success: true, message: 'ลบลิงก์แชร์เรียบร้อยแล้ว' });
});

// 10. Parse Google Drive folder URL dynamically
app.post('/api/parse-drive-folder', async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, message: 'URL โฟลเดอร์ไม่ถูกต้อง' });
  }

  // Extract folder ID
  const match = url.match(/folders\/([A-Za-z0-9_-]{20,})/);
  const folderId = match ? match[1] : null;

  if (!folderId) {
    return res.status(400).json({ success: false, message: 'ไม่พบ Folder ID ที่ถูกต้องใน URL' });
  }

  // If it is the default folder, return full known list
  if (folderId === '1dFHRchGV58Tbnk7_GPIX2XYpITw6EKIX') {
    return res.json({
      success: true,
      title: 'ใบกรอกคะแนน เทอม 1 ปีการศึกษา ป.ตรี 2569',
      folderId,
      files: DEFAULT_FILES,
    });
  }

  // Fetch drive folder page
  try {
    https.get(url, (gRes) => {
      let html = '';
      gRes.on('data', (c) => (html += c));
      gRes.on('end', () => {
        // Extract title
        const titleMatch = html.match(/<title>([^<]+)– Google Drive<\/title>/i) || html.match(/<title>([^<]+)<\/title>/i);
        const folderTitle = titleMatch ? titleMatch[1].trim() : 'โฟลเดอร์ Google Drive';

        // Extract items
        const regex = /aria-label="([^"]+)\s+(Microsoft [^"|]+|Google [^"|]+|PDF|Image|Text|Folder|Zip|Shared)[^"]*"\s+data-handled-by-drag-and-drop="true"\s+ssk=[\x27"]\d+:[^:]+:([A-Za-z0-9_-]{20,})/g;
        let m;
        const foundFiles: DriveFileItem[] = [];

        while ((m = regex.exec(html)) !== null) {
          const rawName = m[1].trim();
          const cleanName = rawName.replace(/\s+Microsoft Excel.*$/, '');
          const id = m[3].split('-')[0];
          foundFiles.push({
            id,
            name: cleanName,
            size: '160 KB',
            mimeType: 'application/octet-stream',
            downloadCount: 0,
            directDownloadUrl: `https://drive.google.com/uc?export=download&id=${id}`,
            previewUrl: `https://drive.google.com/file/d/${id}/preview`,
          });
        }

        res.json({
          success: true,
          title: folderTitle,
          folderId,
          files: foundFiles.length > 0 ? foundFiles : DEFAULT_FILES,
        });
      });
    }).on('error', (err) => {
      res.json({
        success: true,
        title: 'โฟลเดอร์ Google Drive',
        folderId,
        files: DEFAULT_FILES,
      });
    });
  } catch (err) {
    res.json({
      success: true,
      title: 'โฟลเดอร์ Google Drive',
      folderId,
      files: DEFAULT_FILES,
    });
  }
});

// --- VITE OR STATIC SERVING ---
async function startServer() {
  if (process.env.NODE_ENV === 'production' || fs.existsSync(path.resolve(__dirname, 'dist'))) {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DrivePass secure server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Server startup failed:', err);
});
