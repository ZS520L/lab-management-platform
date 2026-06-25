const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const mime = require('mime-types');
const MarkdownIt = require('markdown-it');
const sanitizeHtml = require('sanitize-html');
const { Server } = require('socket.io');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || 'storage/uploads');
const PREVIEW_DIR = path.resolve(ROOT, process.env.PREVIEW_DIR || 'storage/previews');
const DB_PATH = path.join(DATA_DIR, 'lab-platform.sqlite');
const SESSION_SECRET_PATH = path.join(DATA_DIR, 'session-secret.txt');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);
const SHORT_SESSION_MS = 1000 * 60 * 60 * 12;
const REMEMBER_SESSION_MS = 1000 * 60 * 60 * 24 * 30;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: false,
  maxHttpBufferSize: 5 * 1024 * 1024
});

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

function now() {
  return new Date().toISOString();
}

function getSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET !== '[CHANGE_ME]') return process.env.SESSION_SECRET;
  if (fs.existsSync(SESSION_SECRET_PATH)) return fs.readFileSync(SESSION_SECRET_PATH, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SESSION_SECRET_PATH, secret, { encoding: 'utf8' });
  return secret;
}

function safeText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function validateWhitelistUsername(username) {
  if (!/^[\u4e00-\u9fffA-Za-z0-9_-]{2,32}$/.test(username)) {
    return '姓名/登录名需为 2-32 位，可使用中文、英文、数字、下划线或短横线';
  }
  return null;
}

function validateGrade(grade) {
  if (grade && !/^\d{2}级$/.test(grade)) return '年级格式应为 23级、24级 等';
  return null;
}

function maybeFixMojibake(value) {
  const text = safeText(value);
  if (!text) return text;

  // Multer/浏览器在部分 Windows 环境中会把 UTF-8 文件名按 Latin1 解读，
  // 表现为“å½å®¶...”这类乱码。这里仅在修复后明显出现中文时才替换。
  const suspicious = /[\u00c0-\u00ff]/.test(text) || text.includes('�');
  if (!suspicious) return text;

  try {
    const decoded = Buffer.from(text, 'latin1').toString('utf8');
    const decodedCjkCount = (decoded.match(/[\u4e00-\u9fff]/g) || []).length;
    const textCjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    if (decodedCjkCount > textCjkCount && !decoded.includes('�')) return decoded;
  } catch (err) {
    return text;
  }
  return text;
}

function normalizeName(value, fallback = '未命名') {
  const text = maybeFixMojibake(safeText(value, fallback)).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  return text.slice(0, 180) || fallback;
}

function parsePositiveInt(value, fallback = null) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function normalizeWebUrl(value) {
  const raw = safeText(value);
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch (err) {
    return null;
  }
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      grade TEXT DEFAULT '',
      identity TEXT NOT NULL DEFAULT '学生',
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')) DEFAULT 'user',
      active INTEGER NOT NULL DEFAULT 1,
      removed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      mime_type TEXT,
      ext TEXT,
      size_bytes INTEGER NOT NULL,
      uploader_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
      description TEXT DEFAULT '',
      approved_by INTEGER REFERENCES users(id),
      approved_at TEXT,
      rejected_by INTEGER REFERENCES users(id),
      rejected_at TEXT,
      reject_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS announcement_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at TEXT NOT NULL,
      UNIQUE(announcement_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS web_nav_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_nav_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER REFERENCES web_nav_categories(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
      suggested_by INTEGER NOT NULL REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      approved_at TEXT,
      rejected_by INTEGER REFERENCES users(id),
      rejected_at TEXT,
      reject_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      detail TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_files_folder_status ON files(folder_id, status);
    CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_id);
    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
    CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);
    CREATE INDEX IF NOT EXISTS idx_announcement_reads_user ON announcement_reads(user_id, announcement_id);
    CREATE INDEX IF NOT EXISTS idx_file_comments_file ON file_comments(file_id, created_at);
  `);
}

function ensureUserProfileColumns() {
  const columns = db.prepare('PRAGMA table_info(users)').all().map(column => column.name);
  if (!columns.includes('grade')) db.exec("ALTER TABLE users ADD COLUMN grade TEXT DEFAULT ''");
  if (!columns.includes('identity')) db.exec("ALTER TABLE users ADD COLUMN identity TEXT NOT NULL DEFAULT '学生'");
  if (!columns.includes('removed')) db.exec('ALTER TABLE users ADD COLUMN removed INTEGER NOT NULL DEFAULT 0');
  db.prepare("UPDATE users SET display_name = username WHERE display_name IS NULL OR display_name = '' OR display_name != username").run();
  db.prepare("UPDATE users SET identity = '管理员' WHERE role = 'admin' AND (identity IS NULL OR identity = '' OR identity = '学生' OR identity = '老师')").run();
  db.prepare("UPDATE users SET identity = '学生' WHERE role != 'admin' AND (identity IS NULL OR identity = '')").run();
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value, actorId = null) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(key, value, actorId, now());
}

function ensureSharedPassword() {
  if (getSetting('shared_password_hash')) return;
  const configuredPassword = process.env.SHARED_PASSWORD && process.env.SHARED_PASSWORD !== '[CHANGE_ME]' ? process.env.SHARED_PASSWORD : null;
  const legacyPassword = process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== '[CHANGE_ME]' ? process.env.ADMIN_PASSWORD : null;
  const initialPassword = configuredPassword || legacyPassword || 'change-me-on-first-login';
  setSetting('shared_password_hash', bcrypt.hashSync(initialPassword, 12));
  console.log('已初始化统一登录口令。请管理员登录后在管理后台修改。');
}

function verifySharedPassword(password) {
  const hash = getSetting('shared_password_hash');
  return Boolean(hash && bcrypt.compareSync(String(password || ''), hash));
}

function seedInitialData() {
  const createdAt = now();
  const adminUsername = process.env.ADMIN_USER || 'admin';
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername);
  if (!admin) {
    db.prepare(`
      INSERT INTO users (username, display_name, password_hash, grade, identity, role, active, created_at, updated_at)
      VALUES (?, ?, '', '', '管理员', 'admin', 1, ?, ?)
    `).run(adminUsername, adminUsername, createdAt, createdAt);
    console.log(`已创建初始管理员白名单账号：${adminUsername}`);
    console.log('白名单登录已启用：登录时只需要输入姓名。');
  }

  const defaultStudents = [
    { grade: '24级', names: ['吴开元', '林庭镒', '付嘉', '张陈龙', '徐刘涛', '夏雪峰', '林志贤'] },
    { grade: '25级', names: ['蔡磊', '张宏伟', '范立国', '王建豪', '王庆庆', '王擎', '张鑫雨', '张可宜', '武志国', '郑峻岩'] }
  ];
  const insertStudent = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, grade, identity, role, active, removed, created_at, updated_at)
    VALUES (?, ?, '', ?, '学生', 'user', 1, 0, ?, ?)
  `);
  const restoreStudent = db.prepare(`
    UPDATE users SET display_name = username, grade = ?, identity = '学生', role = 'user', active = 1, removed = 0, updated_at = ?
    WHERE username = ?
  `);
  defaultStudents.forEach(group => {
    group.names.forEach(username => {
      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) {
        restoreStudent.run(group.grade, createdAt, username);
      } else {
        insertStudent.run(username, username, group.grade, createdAt, createdAt);
      }
    });
  });

  const folderCount = db.prepare('SELECT COUNT(*) AS count FROM folders').get().count;
  if (folderCount === 0) {
    const adminId = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername).id;
    const insert = db.prepare(`
      INSERT INTO folders (name, parent_id, sort_order, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const roots = [
      ['公告制度', ['实验室制度', '入组必读', '常见问题']],
      ['资料共享', ['论文模板', '组会资料', '软件下载', '项目材料']],
      ['科研文档', ['实验方案', '仿真资料', '数据说明', '毕业归档']]
    ];
    roots.forEach(([name, children], rootIndex) => {
      const info = insert.run(name, null, rootIndex, adminId, createdAt, createdAt);
      children.forEach((child, childIndex) => insert.run(child, info.lastInsertRowid, childIndex, adminId, createdAt, createdAt));
    });
  }

  const navCategoryCount = db.prepare('SELECT COUNT(*) AS count FROM web_nav_categories').get().count;
  if (navCategoryCount === 0) {
    const adminId = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername).id;
    const insertCategory = db.prepare(`
      INSERT INTO web_nav_categories (name, sort_order, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    ['学术检索', '论文写作', '常用工具', '课题相关'].forEach((name, index) => {
      insertCategory.run(name, index * 10, adminId, createdAt, createdAt);
    });
  }
}

ensureSchema();
ensureUserProfileColumns();
ensureSharedPassword();
seedInitialData();
repairMojibakeFilenames();

function repairMojibakeFilenames() {
  const rows = db.prepare('SELECT id, original_name FROM files').all();
  const update = db.prepare('UPDATE files SET original_name = ?, updated_at = ? WHERE id = ?');
  let repaired = 0;
  rows.forEach(row => {
    const fixed = normalizeName(row.original_name, row.original_name);
    if (fixed && fixed !== row.original_name) {
      update.run(fixed, now(), row.id);
      repaired += 1;
    }
  });
  if (repaired > 0) console.log(`已修复 ${repaired} 个乱码文件名`);
}

function audit(actorId, action, targetType, targetId, detail = '') {
  db.prepare(`
    INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(actorId || null, action, targetType, targetId ? String(targetId) : null, detail, now());
}

class SqliteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expired_at ON sessions(expired_at);
    `);
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT sess, expired_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expired_at <= Date.now()) {
        this.destroy(sid, () => callback(null, null));
        return;
      }
      callback(null, JSON.parse(row.sess));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const ttl = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + SHORT_SESSION_MS;
      this.db.prepare(`
        INSERT INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired_at = excluded.expired_at
      `).run(sid, JSON.stringify(sess), ttl);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

const sessionMiddleware = session({
  store: new SqliteSessionStore(db),
  secret: getSessionSecret(),
  name: 'lab.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: REMEMBER_SESSION_MS
  }
});

app.set('views', path.join(ROOT, 'views'));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '2mb' }));
app.use(sessionMiddleware);
app.use('/assets', express.static(path.join(ROOT, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: res => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

function loadUser(req, res, next) {
  if (!req.session.userId) return next();
  const user = db.prepare('SELECT id, username, display_name, grade, identity, role, active, removed FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.active !== 1 || user.removed === 1) {
    req.session.destroy(() => {});
    return next();
  }
  req.user = user;
  res.locals.user = user;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '请先登录' });
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

app.use(loadUser);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const date = new Date();
      const folder = path.join(UPLOAD_DIR, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'));
      fs.mkdirSync(folder, { recursive: true });
      cb(null, folder);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

function folderTree() {
  const rows = db.prepare(`
    SELECT f.*, u.username AS creator_name,
      (SELECT COUNT(*) FROM files WHERE folder_id = f.id AND status = 'approved') AS approved_count,
      (SELECT COUNT(*) FROM files WHERE folder_id = f.id AND status = 'pending') AS pending_count
    FROM folders f
    LEFT JOIN users u ON u.id = f.created_by
    ORDER BY COALESCE(f.parent_id, 0), f.sort_order, f.name COLLATE NOCASE
  `).all();
  const map = new Map();
  rows.forEach(row => map.set(row.id, { ...row, children: [] }));
  const roots = [];
  rows.forEach(row => {
    const node = map.get(row.id);
    if (row.parent_id && map.has(row.parent_id)) map.get(row.parent_id).children.push(node);
    else roots.push(node);
  });
  return roots;
}

function folderSiblings(parentId) {
  const sql = parentId
    ? 'SELECT * FROM folders WHERE parent_id = ? ORDER BY sort_order, name COLLATE NOCASE, id'
    : 'SELECT * FROM folders WHERE parent_id IS NULL ORDER BY sort_order, name COLLATE NOCASE, id';
  return parentId ? db.prepare(sql).all(parentId) : db.prepare(sql).all();
}

function normalizeFolderSort(parentId) {
  const siblings = folderSiblings(parentId);
  const update = db.prepare('UPDATE folders SET sort_order = ?, updated_at = ? WHERE id = ?');
  const updatedAt = now();
  siblings.forEach((folder, index) => update.run((index + 1) * 10, updatedAt, folder.id));
}

function nextFolderSortOrder(parentId) {
  const sql = parentId
    ? 'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM folders WHERE parent_id = ?'
    : 'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM folders WHERE parent_id IS NULL';
  const row = parentId ? db.prepare(sql).get(parentId) : db.prepare(sql).get();
  return Number(row.max_order || 0) + 10;
}

function canAccessFile(user, file) {
  return file.status === 'approved' || user.role === 'admin' || file.uploader_id === user.id;
}

function canDeleteFile(user, file) {
  if (user.role === 'admin') return true;
  return file.uploader_id === user.id && ['pending', 'rejected'].includes(file.status);
}

function canRenameFile(user, file) {
  if (user.role === 'admin') return true;
  return file.uploader_id === user.id && ['pending', 'rejected'].includes(file.status);
}

function fileAbsolutePath(file) {
  return path.resolve(ROOT, file.relative_path);
}

function fileDto(file) {
  const officeFile = isOfficeFile(file);
  return {
    id: file.id,
    folder_id: file.folder_id,
    original_name: file.original_name,
    mime_type: file.mime_type,
    ext: file.ext,
    size_bytes: file.size_bytes,
    status: file.status,
    description: file.description || '',
    uploader_id: file.uploader_id,
    uploader_name: file.uploader_name,
    folder_name: file.folder_name,
    approved_by_name: file.approved_by_name,
    approved_at: file.approved_at,
    reject_reason: file.reject_reason,
    created_at: file.created_at,
    updated_at: file.updated_at,
    is_office: officeFile,
    office_preview_ready: officeFile ? hasOfficePdfPreview(file) : false,
    preview_url: `/api/files/${file.id}/preview`,
    download_url: `/api/files/${file.id}/download`
  };
}

function fetchFile(id) {
  return db.prepare(`
    SELECT f.*, folder.name AS folder_name, uploader.username AS uploader_name,
      approver.username AS approved_by_name
    FROM files f
    JOIN folders folder ON folder.id = f.folder_id
    JOIN users uploader ON uploader.id = f.uploader_id
    LEFT JOIN users approver ON approver.id = f.approved_by
    WHERE f.id = ?
  `).get(id);
}

function renderMarkdown(text) {
  const raw = md.render(text || '');
  return sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'h3', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title']
    }
  });
}

function isOfficeFile(file) {
  return ['.doc', '.docx', '.ppt', '.pptx'].includes((file.ext || '').toLowerCase());
}

function hasOfficePdfPreview(file) {
  if (!isOfficeFile(file)) return false;
  const sourcePath = fileAbsolutePath(file);
  const targetPdf = officePreviewPath(file);
  if (!fs.existsSync(sourcePath) || !fs.existsSync(targetPdf)) return false;
  const sourceStat = fs.statSync(sourcePath);
  const previewStat = fs.statSync(targetPdf);
  return previewStat.mtimeMs >= sourceStat.mtimeMs && previewStat.size > 0;
}

const officePreviewJobs = new Set();

function prebuildOfficePreview(file, reason = '后台预转换') {
  if (!isOfficeFile(file)) return;
  if (hasOfficePdfPreview(file)) return;
  if (officePreviewJobs.has(file.id)) return;
  officePreviewJobs.add(file.id);
  ensureOfficePdfPreview(file)
    .then(() => console.log(`${reason}完成：${file.original_name}`))
    .catch(err => console.error(`${reason}失败：${file.original_name}`, err.message))
    .finally(() => officePreviewJobs.delete(file.id));
}

function officePreviewPath(file) {
  return path.join(PREVIEW_DIR, `${file.id}.pdf`);
}

function officeWorkDir(file) {
  return path.join(PREVIEW_DIR, `work-${file.id}`);
}

function candidateLibreOfficeCommands() {
  const commands = [];
  if (process.env.LIBREOFFICE_PATH) commands.push(process.env.LIBREOFFICE_PATH);
  commands.push('soffice');
  commands.push('libreoffice');
  if (process.platform === 'win32') {
    commands.push('C:\\Program Files\\LibreOffice\\program\\soffice.exe');
    commands.push('C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe');
  }
  return [...new Set(commands.filter(Boolean))];
}

function runLibreOffice(command, inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    execFile(command, [
      '--headless',
      '--nologo',
      '--nofirststartwizard',
      '--convert-to',
      'pdf',
      '--outdir',
      outputDir,
      inputPath
    ], { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message}\n${stdout || ''}\n${stderr || ''}`.trim();
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ensureOfficePdfPreview(file) {
  if (!isOfficeFile(file)) throw new Error('该文件不是 Office 文档');
  const sourcePath = fileAbsolutePath(file);
  if (!fs.existsSync(sourcePath)) throw new Error('源文件已丢失');

  const targetPdf = officePreviewPath(file);
  if (fs.existsSync(targetPdf)) {
    const sourceStat = fs.statSync(sourcePath);
    const previewStat = fs.statSync(targetPdf);
    if (previewStat.mtimeMs >= sourceStat.mtimeMs && previewStat.size > 0) return targetPdf;
  }

  const workDir = officeWorkDir(file);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const ext = path.extname(file.original_name || file.relative_path || sourcePath).toLowerCase() || file.ext || '';
  const safeInput = path.join(workDir, `source${ext}`);
  fs.copyFileSync(sourcePath, safeInput);

  let lastError = null;
  for (const command of candidateLibreOfficeCommands()) {
    try {
      await runLibreOffice(command, safeInput, workDir);
      const converted = path.join(workDir, 'source.pdf');
      if (!fs.existsSync(converted)) throw new Error('LibreOffice 未生成 PDF 文件');
      fs.copyFileSync(converted, targetPdf);
      fs.rmSync(workDir, { recursive: true, force: true });
      return targetPdf;
    } catch (err) {
      lastError = err;
    }
  }

  fs.rmSync(workDir, { recursive: true, force: true });
  const error = new Error('Office 预览需要安装 LibreOffice，并确保 soffice 命令可用，或在 .env 中配置 LIBREOFFICE_PATH。');
  error.cause = lastError;
  throw error;
}

function leaderboardStart(range) {
  if (range === 'week') return new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString();
  if (range === 'month') return new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString();
  return null;
}

function leaderboardTitle(range) {
  return range === 'week' ? '周榜' : range === 'month' ? '月榜' : '总榜';
}

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const username = safeText(req.body.username);
  const sharedPassword = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1 AND removed = 0').get(username);
  if (!user) {
    return res.status(401).render('login', { error: '该姓名不在白名单中，请联系管理员添加' });
  }
  if (!verifySharedPassword(sharedPassword)) return res.status(401).render('login', { error: '统一登录码不正确' });
  req.session.userId = user.id;
  req.session.cookie.maxAge = req.body.remember === 'on' ? REMEMBER_SESSION_MS : SHORT_SESSION_MS;
  audit(user.id, 'login', 'user', user.id, req.body.remember === 'on' ? '白名单统一登录码登录并保持登录' : '白名单统一登录码登录');
  res.redirect('/');
});

app.post('/logout', requireAuth, (req, res) => {
  const userId = req.user.id;
  req.session.destroy(() => {
    audit(userId, 'logout', 'user', userId, '用户退出');
    res.redirect('/login');
  });
});

app.get('/', requireAuth, (req, res) => {
  res.render('app', { user: req.user });
});

app.get('/api/session', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/tree', requireAuth, (req, res) => {
  res.json({ folders: folderTree() });
});

app.get('/api/web-nav', requireAuth, (req, res) => {
  const includeAll = req.user.role === 'admin' && req.query.include_pending === '1';
  const categories = db.prepare(`
    SELECT id, name, sort_order, created_at, updated_at
    FROM web_nav_categories
    ORDER BY sort_order, name COLLATE NOCASE, id
  `).all();
  const where = includeAll ? '' : "WHERE l.status = 'approved'";
  const links = db.prepare(`
    SELECT l.*, c.name AS category_name,
      suggester.username AS suggested_by_name,
      approver.username AS approved_by_name,
      rejecter.username AS rejected_by_name
    FROM web_nav_links l
    LEFT JOIN web_nav_categories c ON c.id = l.category_id
    JOIN users suggester ON suggester.id = l.suggested_by
    LEFT JOIN users approver ON approver.id = l.approved_by
    LEFT JOIN users rejecter ON rejecter.id = l.rejected_by
    ${where}
    ORDER BY COALESCE(c.sort_order, 999999), c.name COLLATE NOCASE, l.status DESC, l.title COLLATE NOCASE, l.created_at DESC
  `).all();
  res.json({ categories, links, include_all: includeAll });
});

app.post('/api/web-nav/categories', requireAuth, requireAdmin, (req, res) => {
  const name = safeText(req.body.name).slice(0, 60);
  if (!name) return res.status(400).json({ error: '分类名不能为空' });
  const createdAt = now();
  const nextOrder = Number(db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM web_nav_categories').get().max_order || 0) + 10;
  try {
    const info = db.prepare(`
      INSERT INTO web_nav_categories (name, sort_order, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, nextOrder, req.user.id, createdAt, createdAt);
    audit(req.user.id, 'create', 'web_nav_category', info.lastInsertRowid, `创建网页导航分类：${name}`);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: '该分类已存在' });
    throw err;
  }
});

app.patch('/api/web-nav/categories/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const category = db.prepare('SELECT * FROM web_nav_categories WHERE id = ?').get(id);
  if (!category) return res.status(404).json({ error: '分类不存在' });
  const name = safeText(req.body.name, category.name).slice(0, 60);
  if (!name) return res.status(400).json({ error: '分类名不能为空' });
  try {
    db.prepare('UPDATE web_nav_categories SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id);
    audit(req.user.id, 'update', 'web_nav_category', id, `更新网页导航分类：${category.name} -> ${name}`);
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: '该分类已存在' });
    throw err;
  }
});

app.delete('/api/web-nav/categories/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const category = db.prepare('SELECT * FROM web_nav_categories WHERE id = ?').get(id);
  if (!category) return res.status(404).json({ error: '分类不存在' });
  db.prepare('UPDATE web_nav_links SET category_id = NULL, updated_at = ? WHERE category_id = ?').run(now(), id);
  db.prepare('DELETE FROM web_nav_categories WHERE id = ?').run(id);
  audit(req.user.id, 'delete', 'web_nav_category', id, `删除网页导航分类：${category.name}`);
  res.json({ ok: true });
});

app.post('/api/web-nav/links', requireAuth, (req, res) => {
  const title = safeText(req.body.title).slice(0, 120);
  const url = normalizeWebUrl(req.body.url);
  const description = safeText(req.body.description).slice(0, 500);
  const categoryId = parsePositiveInt(req.body.category_id, null);
  if (!title || !url) return res.status(400).json({ error: '网站名称和网址不能为空' });
  if (categoryId && !db.prepare('SELECT id FROM web_nav_categories WHERE id = ?').get(categoryId)) {
    return res.status(400).json({ error: '分类不存在' });
  }
  const createdAt = now();
  const status = req.user.role === 'admin' ? 'approved' : 'pending';
  const info = db.prepare(`
    INSERT INTO web_nav_links (category_id, title, url, description, status, suggested_by, approved_by, approved_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(categoryId, title, url, description, status, req.user.id, status === 'approved' ? req.user.id : null, status === 'approved' ? createdAt : null, createdAt, createdAt);
  audit(req.user.id, 'create', 'web_nav_link', info.lastInsertRowid, `${status === 'approved' ? '添加' : '推荐'}网页导航：${title}`);
  res.json({ ok: true, id: Number(info.lastInsertRowid), status });
});

app.patch('/api/web-nav/links/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const link = db.prepare('SELECT * FROM web_nav_links WHERE id = ?').get(id);
  if (!link) return res.status(404).json({ error: '链接不存在' });
  const title = req.body.title !== undefined ? safeText(req.body.title).slice(0, 120) : link.title;
  const url = req.body.url !== undefined ? normalizeWebUrl(req.body.url) : link.url;
  const description = req.body.description !== undefined ? safeText(req.body.description).slice(0, 500) : link.description;
  const categoryId = req.body.category_id === '' || req.body.category_id === null || req.body.category_id === undefined
    ? (req.body.category_id === undefined ? link.category_id : null)
    : parsePositiveInt(req.body.category_id, null);
  const status = ['pending', 'approved', 'rejected'].includes(req.body.status) ? req.body.status : link.status;
  const rejectReason = status === 'rejected' ? safeText(req.body.reject_reason, link.reject_reason || '未填写原因').slice(0, 300) : null;
  if (!title || !url) return res.status(400).json({ error: '网站名称和网址不能为空' });
  if (categoryId && !db.prepare('SELECT id FROM web_nav_categories WHERE id = ?').get(categoryId)) {
    return res.status(400).json({ error: '分类不存在' });
  }
  const updatedAt = now();
  db.prepare(`
    UPDATE web_nav_links SET
      category_id = ?, title = ?, url = ?, description = ?, status = ?,
      approved_by = ?, approved_at = ?, rejected_by = ?, rejected_at = ?, reject_reason = ?, updated_at = ?
    WHERE id = ?
  `).run(
    categoryId, title, url, description, status,
    status === 'approved' ? req.user.id : null,
    status === 'approved' ? updatedAt : null,
    status === 'rejected' ? req.user.id : null,
    status === 'rejected' ? updatedAt : null,
    rejectReason,
    updatedAt,
    id
  );
  audit(req.user.id, 'update', 'web_nav_link', id, `维护网页导航：${link.title} -> ${title}（${status}）`);
  res.json({ ok: true });
});

app.delete('/api/web-nav/links/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const link = db.prepare('SELECT * FROM web_nav_links WHERE id = ?').get(id);
  if (!link) return res.status(404).json({ error: '链接不存在' });
  db.prepare('DELETE FROM web_nav_links WHERE id = ?').run(id);
  audit(req.user.id, 'delete', 'web_nav_link', id, `删除网页导航：${link.title}`);
  res.json({ ok: true });
});

app.post('/api/folders', requireAuth, requireAdmin, (req, res) => {
  const name = normalizeName(req.body.name, '新文件夹');
  const parentId = parsePositiveInt(req.body.parent_id, null);
  if (parentId && !db.prepare('SELECT id FROM folders WHERE id = ?').get(parentId)) {
    return res.status(400).json({ error: '父目录不存在' });
  }
  const createdAt = now();
  const info = db.prepare(`
    INSERT INTO folders (name, parent_id, sort_order, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, parentId, nextFolderSortOrder(parentId), req.user.id, createdAt, createdAt);
  audit(req.user.id, 'create', 'folder', info.lastInsertRowid, `创建目录：${name}`);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.patch('/api/folders/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  if (!folder) return res.status(404).json({ error: '目录不存在' });
  const name = normalizeName(req.body.name, folder.name);
  db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id);
  audit(req.user.id, 'update', 'folder', id, `重命名目录：${folder.name} -> ${name}`);
  res.json({ ok: true });
});

app.post('/api/folders/:id/move', requireAuth, requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const direction = req.body.direction === 'up' ? 'up' : req.body.direction === 'down' ? 'down' : null;
  if (!direction) return res.status(400).json({ error: '移动方向不正确' });

  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  if (!folder) return res.status(404).json({ error: '目录不存在' });

  const parentId = folder.parent_id || null;
  normalizeFolderSort(parentId);
  const siblings = folderSiblings(parentId);
  const index = siblings.findIndex(item => item.id === folder.id);
  if (index < 0) return res.status(404).json({ error: '目录不存在' });

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= siblings.length) {
    return res.status(400).json({ error: direction === 'up' ? '已经是第一个目录' : '已经是最后一个目录' });
  }

  const current = siblings[index];
  const target = siblings[targetIndex];
  const updatedAt = now();
  const update = db.prepare('UPDATE folders SET sort_order = ?, updated_at = ? WHERE id = ?');
  update.run(target.sort_order, updatedAt, current.id);
  update.run(current.sort_order, updatedAt, target.id);
  audit(req.user.id, 'move', 'folder', id, `${direction === 'up' ? '上移' : '下移'}目录：${folder.name}`);
  res.json({ ok: true });
});

app.delete('/api/folders/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  if (!folder) return res.status(404).json({ error: '目录不存在' });

  const childCount = db.prepare('SELECT COUNT(*) AS count FROM folders WHERE parent_id = ?').get(id).count;
  if (childCount > 0) return res.status(400).json({ error: '该目录下还有子目录，不能直接删除' });

  const fileCount = db.prepare('SELECT COUNT(*) AS count FROM files WHERE folder_id = ?').get(id).count;
  if (fileCount > 0) return res.status(400).json({ error: '该目录下还有文件，不能直接删除。请先移动文件' });

  db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  audit(req.user.id, 'delete', 'folder', id, `删除目录：${folder.name}`);
  res.json({ ok: true });
});

app.get('/api/folders/:id/files', requireAuth, (req, res) => {
  const folderId = parsePositiveInt(req.params.id);
  if (!db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId)) return res.status(404).json({ error: '目录不存在' });

  const includePending = req.user.role === 'admin' && req.query.include_pending === '1';
  const sort = ['uploader', 'time_desc', 'time_asc', 'type', 'name'].includes(req.query.sort) ? req.query.sort : 'uploader';
  const orderByMap = {
    uploader: 'uploader.username COLLATE NOCASE ASC, f.created_at DESC, f.original_name COLLATE NOCASE ASC',
    time_desc: 'f.created_at DESC, uploader.username COLLATE NOCASE ASC',
    time_asc: 'f.created_at ASC, uploader.username COLLATE NOCASE ASC',
    type: "LOWER(COALESCE(NULLIF(f.ext, ''), f.mime_type, '')) COLLATE NOCASE ASC, uploader.username COLLATE NOCASE ASC, f.created_at DESC",
    name: 'f.original_name COLLATE NOCASE ASC, f.created_at DESC'
  };
  const sql = `
    SELECT f.*, folder.name AS folder_name, uploader.username AS uploader_name,
      approver.username AS approved_by_name
    FROM files f
    JOIN folders folder ON folder.id = f.folder_id
    JOIN users uploader ON uploader.id = f.uploader_id
    LEFT JOIN users approver ON approver.id = f.approved_by
    WHERE f.folder_id = ? AND (${includePending ? '1 = 1' : "f.status = 'approved' OR f.uploader_id = ?"})
    ORDER BY ${orderByMap[sort]}
  `;
  const rows = includePending
    ? db.prepare(sql).all(folderId)
    : db.prepare(sql).all(folderId, req.user.id);
  res.json({ files: rows.map(fileDto) });
});

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择要上传的文件' });
  const folderId = parsePositiveInt(req.body.folder_id);
  const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId);
  if (!folder) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: '目标目录不存在' });
  }

  const fileId = crypto.randomUUID();
  const originalName = normalizeName(req.file.originalname || req.file.filename, '未命名文件');
  const ext = path.extname(originalName).toLowerCase();
  const mimeType = req.file.mimetype || mime.lookup(originalName) || 'application/octet-stream';
  const status = req.user.role === 'admin' ? 'approved' : 'pending';
  const createdAt = now();
  const relativePath = path.relative(ROOT, req.file.path).replace(/\\/g, '/');
  db.prepare(`
    INSERT INTO files (
      id, folder_id, original_name, stored_name, relative_path, mime_type, ext, size_bytes,
      uploader_id, status, description, approved_by, approved_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileId,
    folderId,
    originalName,
    req.file.filename,
    relativePath,
    mimeType,
    ext,
    req.file.size,
    req.user.id,
    status,
    safeText(req.body.description).slice(0, 1000),
    status === 'approved' ? req.user.id : null,
    status === 'approved' ? createdAt : null,
    createdAt,
    createdAt
  );
  const uploadedFile = { id: fileId, ext, original_name: originalName, relative_path: relativePath };
  prebuildOfficePreview(uploadedFile, 'Office 文件上传后预转换');
  audit(req.user.id, 'upload', 'file', fileId, `${status === 'approved' ? '管理员上传并发布' : '组员上传待审核'}：${originalName}`);
  res.json({ ok: true, id: fileId, status });
});

app.get('/api/files/:id', requireAuth, (req, res) => {
  const file = fetchFile(req.params.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  if (!canAccessFile(req.user, file)) return res.status(403).json({ error: '无权访问该文件' });

  const dto = fileDto(file);
  if (['.md', '.markdown', '.txt'].includes((file.ext || '').toLowerCase())) {
    const abs = fileAbsolutePath(file);
    if (fs.existsSync(abs) && file.size_bytes <= 5 * 1024 * 1024) {
      const text = fs.readFileSync(abs, 'utf8');
      dto.text_preview = text;
      dto.html_preview = file.ext === '.md' || file.ext === '.markdown' ? renderMarkdown(text) : null;
    }
  }
  res.json({ file: dto });
});

app.patch('/api/files/:id', requireAuth, (req, res) => {
  const file = fetchFile(req.params.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  if (!canRenameFile(req.user, file)) return res.status(403).json({ error: '无权修改该文件名' });

  let originalName = normalizeName(req.body.original_name || req.body.name || '', '');
  if (!originalName) return res.status(400).json({ error: '文件名不能为空' });
  if (!path.extname(originalName) && file.ext) originalName += file.ext;
  const ext = path.extname(originalName).toLowerCase();
  const mimeType = mime.lookup(originalName) || file.mime_type || 'application/octet-stream';
  db.prepare('UPDATE files SET original_name = ?, ext = ?, mime_type = ?, updated_at = ? WHERE id = ?')
    .run(originalName, ext, mimeType, now(), file.id);
  audit(req.user.id, 'rename', 'file', file.id, `修改文件名：${file.original_name} -> ${originalName}`);
  const updated = fetchFile(file.id);
  res.json({ ok: true, file: fileDto(updated) });
});

app.get('/api/files/:id/preview', requireAuth, (req, res) => {
  const file = fetchFile(req.params.id);
  if (!file) return res.status(404).send('文件不存在');
  if (!canAccessFile(req.user, file)) return res.status(403).send('无权访问该文件');
  const abs = fileAbsolutePath(file);
  if (!fs.existsSync(abs)) return res.status(404).send('文件已丢失');

  res.setHeader('Content-Type', file.mime_type || mime.lookup(file.original_name) || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  res.sendFile(abs);
});

app.get('/api/files/:id/office-preview', requireAuth, async (req, res) => {
  const file = fetchFile(req.params.id);
  if (!file) return res.status(404).send('文件不存在');
  if (!canAccessFile(req.user, file)) return res.status(403).send('无权访问该文件');
  if (!isOfficeFile(file)) return res.status(400).send('该文件不是 Word 或 PowerPoint 文档');

  try {
    const pdfPath = await ensureOfficePdfPreview(file);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name.replace(/\.[^.]+$/, '.pdf'))}`);
    res.sendFile(pdfPath);
  } catch (err) {
    console.error('Office 预览转换失败:', err.message);
    res.status(500).send(err.message || 'Office 预览转换失败');
  }
});

app.get('/api/files/:id/comments', requireAuth, (req, res) => {
  const file = fetchFile(req.params.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  if (!canAccessFile(req.user, file)) return res.status(403).json({ error: '无权访问该文件' });

  const comments = db.prepare(`
    SELECT c.id, c.file_id, c.content, c.created_at, c.updated_at,
      u.id AS user_id, u.username, u.display_name, u.grade, u.identity
    FROM file_comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.file_id = ?
    ORDER BY c.created_at DESC
    LIMIT 200
  `).all(file.id);
  res.json({ comments });
});

app.post('/api/files/:id/comments', requireAuth, (req, res) => {
  const file = fetchFile(req.params.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  if (!canAccessFile(req.user, file)) return res.status(403).json({ error: '无权访问该文件' });

  const content = safeText(req.body.content).slice(0, 3000);
  if (!content) return res.status(400).json({ error: '笔记内容不能为空' });
  const createdAt = now();
  const info = db.prepare(`
    INSERT INTO file_comments (file_id, user_id, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(file.id, req.user.id, content, createdAt, createdAt);
  audit(req.user.id, 'comment', 'file', file.id, `添加文件笔记：${file.original_name}`);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

app.delete('/api/files/:fileId/comments/:commentId', requireAuth, (req, res) => {
  const file = fetchFile(req.params.fileId);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  if (!canAccessFile(req.user, file)) return res.status(403).json({ error: '无权访问该文件' });

  const commentId = parsePositiveInt(req.params.commentId);
  const comment = db.prepare('SELECT * FROM file_comments WHERE id = ? AND file_id = ?').get(commentId, file.id);
  if (!comment) return res.status(404).json({ error: '笔记不存在' });
  if (req.user.role !== 'admin' && comment.user_id !== req.user.id) {
    return res.status(403).json({ error: '只能删除自己写的笔记' });
  }

  db.prepare('DELETE FROM file_comments WHERE id = ?').run(comment.id);
  audit(req.user.id, 'delete', 'file_comment', comment.id, `删除文件笔记：${file.original_name}`);
  res.json({ ok: true });
});

app.get('/api/files/:id/download', requireAuth, (req, res) => {
  const file = fetchFile(req.params.id);
  if (!file) return res.status(404).send('文件不存在');
  if (!canAccessFile(req.user, file)) return res.status(403).send('无权访问该文件');
  const abs = fileAbsolutePath(file);
  if (!fs.existsSync(abs)) return res.status(404).send('文件已丢失');
  audit(req.user.id, 'download', 'file', file.id, `下载文件：${file.original_name}`);
  res.download(abs, file.original_name);
});

app.delete('/api/files/:id', requireAuth, (req, res) => {
  const file = fetchFile(req.params.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  if (!canDeleteFile(req.user, file)) return res.status(403).json({ error: '无权删除该文件' });

  db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
  fs.rmSync(fileAbsolutePath(file), { force: true });
  if (isOfficeFile(file)) fs.rmSync(officePreviewPath(file), { force: true });
  audit(req.user.id, 'delete', 'file', file.id, `删除文件记录：${file.original_name}`);
  res.json({ ok: true });
});

app.patch('/api/admin/files/:id/move', requireAuth, requireAdmin, (req, res) => {
  const file = fetchFile(req.params.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });

  const targetFolderId = parsePositiveInt(req.body.folder_id);
  const targetFolder = db.prepare('SELECT * FROM folders WHERE id = ?').get(targetFolderId);
  if (!targetFolder) return res.status(400).json({ error: '目标目录不存在' });
  if (targetFolder.id === file.folder_id) return res.json({ ok: true });

  db.prepare('UPDATE files SET folder_id = ?, updated_at = ? WHERE id = ?').run(targetFolder.id, now(), file.id);
  audit(req.user.id, 'move', 'file', file.id, `移动文件：${file.original_name}；${file.folder_name} -> ${targetFolder.name}`);
  res.json({ ok: true });
});

app.get('/api/admin/pending', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT f.*, folder.name AS folder_name, uploader.username AS uploader_name,
      approver.username AS approved_by_name
    FROM files f
    JOIN folders folder ON folder.id = f.folder_id
    JOIN users uploader ON uploader.id = f.uploader_id
    LEFT JOIN users approver ON approver.id = f.approved_by
    WHERE f.status = 'pending'
    ORDER BY f.created_at ASC
  `).all();
  res.json({ files: rows.map(fileDto) });
});

app.post('/api/admin/files/batch-approve', requireAuth, requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? [...new Set(req.body.ids.map(item => safeText(item)).filter(Boolean))]
    : [];
  const rows = ids.length
    ? db.prepare(`SELECT * FROM files WHERE status = 'pending' AND id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : db.prepare("SELECT * FROM files WHERE status = 'pending'").all();
  if (!rows.length) return res.json({ ok: true, count: 0 });

  const approvedAt = now();
  const approve = db.prepare(`
    UPDATE files SET status = 'approved', approved_by = ?, approved_at = ?, rejected_by = NULL,
      rejected_at = NULL, reject_reason = NULL, updated_at = ? WHERE id = ?
  `);
  rows.forEach(file => {
    approve.run(req.user.id, approvedAt, approvedAt, file.id);
    prebuildOfficePreview(file, 'Office 文件批量审核通过后预转换');
    audit(req.user.id, 'approve', 'file', file.id, `批量审核通过：${file.original_name}`);
  });
  res.json({ ok: true, count: rows.length });
});

app.post('/api/admin/files/:id/approve', requireAuth, requireAdmin, (req, res) => {
  const file = fetchFile(req.params.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  db.prepare(`
    UPDATE files SET status = 'approved', approved_by = ?, approved_at = ?, rejected_by = NULL,
      rejected_at = NULL, reject_reason = NULL, updated_at = ? WHERE id = ?
  `).run(req.user.id, now(), now(), file.id);
  prebuildOfficePreview(file, 'Office 文件审核通过后预转换');
  audit(req.user.id, 'approve', 'file', file.id, `审核通过：${file.original_name}`);
  res.json({ ok: true });
});

app.post('/api/admin/files/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const file = fetchFile(req.params.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  const reason = safeText(req.body.reason, '未填写原因').slice(0, 500);
  db.prepare(`
    UPDATE files SET status = 'rejected', rejected_by = ?, rejected_at = ?, reject_reason = ?, updated_at = ? WHERE id = ?
  `).run(req.user.id, now(), reason, now(), file.id);
  audit(req.user.id, 'reject', 'file', file.id, `审核拒绝：${file.original_name}；原因：${reason}`);
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, display_name, grade, identity, role, active, created_at, updated_at
    FROM users WHERE removed = 0 ORDER BY created_at DESC
  `).all();
  res.json({ users });
});

app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const username = safeText(req.body.username);
  const grade = safeText(req.body.grade);
  const identity = ['学生', '老师', '管理员'].includes(req.body.identity) ? req.body.identity : '学生';
  const role = identity === '管理员' ? 'admin' : 'user';
  const usernameError = validateWhitelistUsername(username);
  const gradeError = validateGrade(grade);
  if (usernameError) return res.status(400).json({ error: usernameError });
  if (gradeError) return res.status(400).json({ error: gradeError });

  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existing && existing.removed !== 1) return res.status(409).json({ error: '该姓名已在白名单中' });

  const createdAt = now();
  if (existing && existing.removed === 1) {
    db.prepare(`
      UPDATE users SET display_name = ?, grade = ?, identity = ?, role = ?, active = 1, removed = 0, updated_at = ?
      WHERE id = ?
    `).run(username, grade, identity, role, createdAt, existing.id);
    audit(req.user.id, 'restore', 'user', existing.id, `恢复白名单用户：${username}`);
    return res.json({ ok: true, id: Number(existing.id) });
  }

  const info = db.prepare(`
    INSERT INTO users (username, display_name, password_hash, grade, identity, role, active, removed, created_at, updated_at)
    VALUES (?, ?, '', ?, ?, ?, 1, 0, ?, ?)
  `).run(username, username, grade, identity, role, createdAt, createdAt);
  audit(req.user.id, 'create', 'user', info.lastInsertRowid, `添加白名单用户：${username}`);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND removed = 0').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const username = req.body.username !== undefined ? safeText(req.body.username) : user.username;
  const grade = req.body.grade !== undefined ? safeText(req.body.grade) : user.grade;
  const identity = ['学生', '老师', '管理员'].includes(req.body.identity) ? req.body.identity : user.identity;
  const role = identity === '管理员' ? 'admin' : 'user';
  const active = req.body.active === undefined ? user.active : req.body.active ? 1 : 0;
  const usernameError = validateWhitelistUsername(username);
  const gradeError = validateGrade(grade);
  if (usernameError) return res.status(400).json({ error: usernameError });
  if (gradeError) return res.status(400).json({ error: gradeError });
  if (id === req.user.id && active !== 1) return res.status(400).json({ error: '不能停用当前登录账号' });

  const otherActiveAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE id != ? AND role = 'admin' AND active = 1 AND removed = 0").get(id).count;
  if (user.role === 'admin' && user.active === 1 && otherActiveAdmins === 0 && !(role === 'admin' && active === 1)) {
    return res.status(400).json({ error: '至少保留一个启用的管理员账号' });
  }

  try {
    db.prepare('UPDATE users SET username = ?, display_name = ?, grade = ?, identity = ?, role = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(username, username, grade, identity, role, active, now(), id);
    audit(req.user.id, 'update', 'user', id, `更新白名单用户：${user.username} -> ${username}`);
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: '该姓名已在白名单中' });
    throw err;
  }
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND removed = 0').get(id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (id === req.user.id) return res.status(400).json({ error: '不能删除当前登录账号' });

  const otherActiveAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE id != ? AND role = 'admin' AND active = 1 AND removed = 0").get(id).count;
  if (user.role === 'admin' && user.active === 1 && otherActiveAdmins === 0) {
    return res.status(400).json({ error: '至少保留一个启用的管理员账号' });
  }

  db.prepare('UPDATE users SET active = 0, removed = 1, updated_at = ? WHERE id = ?').run(now(), id);
  audit(req.user.id, 'delete', 'user', id, `删除白名单用户：${user.username}`);
  res.json({ ok: true });
});

app.post('/api/me/password', requireAuth, (req, res) => {
  res.status(410).json({ error: '当前已改为白名单登录，不需要设置口令' });
});

app.post('/api/admin/access-key', requireAuth, requireAdmin, (req, res) => {
  const code = String(req.body.code || '');
  if (code.length < 6) return res.status(400).json({ error: '统一访问码至少 6 位' });
  setSetting('shared_password_hash', bcrypt.hashSync(code, 12), req.user.id);
  db.prepare('DELETE FROM sessions WHERE sid != ?').run(req.sessionID);
  res.json({ ok: true });
});

app.get('/api/announcements', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.display_name AS author_name
    FROM announcements a
    JOIN users u ON u.id = a.created_by
    ORDER BY a.pinned DESC, a.created_at DESC
    LIMIT 20
  `).all();
  res.json({ announcements: rows });
});

app.get('/api/announcements/unread', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.display_name AS author_name
    FROM announcements a
    JOIN users u ON u.id = a.created_by
    LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
    WHERE r.id IS NULL
    ORDER BY a.pinned DESC, a.created_at DESC
    LIMIT 20
  `).all(req.user.id);
  res.json({ announcements: rows });
});

app.post('/api/announcements/:id/read', requireAuth, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const announcement = db.prepare('SELECT id FROM announcements WHERE id = ?').get(id);
  if (!announcement) return res.status(404).json({ error: '公告不存在' });
  db.prepare(`
    INSERT INTO announcement_reads (announcement_id, user_id, read_at)
    VALUES (?, ?, ?)
    ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at = excluded.read_at
  `).run(id, req.user.id, now());
  res.json({ ok: true });
});

app.post('/api/announcements/read-all', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? req.body.ids.map(item => parsePositiveInt(item)).filter(Boolean)
    : [];
  const rows = ids.length
    ? ids.map(id => db.prepare('SELECT id FROM announcements WHERE id = ?').get(id)).filter(Boolean)
    : db.prepare('SELECT id FROM announcements').all();
  const markRead = db.prepare(`
    INSERT INTO announcement_reads (announcement_id, user_id, read_at)
    VALUES (?, ?, ?)
    ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at = excluded.read_at
  `);
  const readAt = now();
  rows.forEach(row => markRead.run(row.id, req.user.id, readAt));
  res.json({ ok: true, count: rows.length });
});

app.get('/api/leaderboard', requireAuth, (req, res) => {
  const range = ['week', 'month', 'total'].includes(req.query.range) ? req.query.range : 'week';
  const startAt = leaderboardStart(range);
  const whereDate = startAt ? 'AND COALESCE(f.approved_at, f.created_at) >= ?' : '';
  const sql = `
    SELECT u.id AS user_id, u.username, u.display_name, u.grade, u.identity,
      COUNT(f.id) AS approved_count,
      MAX(COALESCE(f.approved_at, f.created_at)) AS latest_approved_at
    FROM files f
    JOIN users u ON u.id = f.uploader_id
    WHERE f.status = 'approved' ${whereDate}
    GROUP BY u.id, u.username, u.display_name, u.grade, u.identity
    HAVING approved_count > 0
    ORDER BY approved_count DESC, latest_approved_at DESC, u.display_name COLLATE NOCASE ASC
    LIMIT 50
  `;
  const rows = startAt ? db.prepare(sql).all(startAt) : db.prepare(sql).all();
  res.json({ range, title: leaderboardTitle(range), start_at: startAt, leaderboard: rows });
});

app.post('/api/announcements', requireAuth, requireAdmin, (req, res) => {
  const title = safeText(req.body.title).slice(0, 120);
  const content = safeText(req.body.content).slice(0, 3000);
  if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
  const createdAt = now();
  const info = db.prepare(`
    INSERT INTO announcements (title, content, pinned, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(title, content, req.body.pinned ? 1 : 0, req.user.id, createdAt, createdAt);
  audit(req.user.id, 'create', 'announcement', info.lastInsertRowid, `发布公告：${title}`);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/announcements/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!announcement) return res.status(404).json({ error: '公告不存在' });
  db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
  audit(req.user.id, 'delete', 'announcement', id, `删除公告：${announcement.title}`);
  res.json({ ok: true });
});

app.get('/api/notes', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT n.id, n.title, n.folder_id, n.created_at, n.updated_at,
      creator.display_name AS creator_name, updater.display_name AS updater_name,
      folder.name AS folder_name
    FROM notes n
    JOIN users creator ON creator.id = n.created_by
    LEFT JOIN users updater ON updater.id = n.updated_by
    LEFT JOIN folders folder ON folder.id = n.folder_id
    ORDER BY n.updated_at DESC
  `).all();
  res.json({ notes: rows });
});

app.post('/api/notes', requireAuth, (req, res) => {
  const title = safeText(req.body.title, '未命名笔记').slice(0, 160);
  const folderId = parsePositiveInt(req.body.folder_id, null);
  if (folderId && !db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId)) return res.status(400).json({ error: '目录不存在' });
  const id = crypto.randomUUID();
  const createdAt = now();
  db.prepare(`
    INSERT INTO notes (id, title, content, folder_id, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, '', ?, ?, ?, ?, ?)
  `).run(id, title, folderId, req.user.id, req.user.id, createdAt, createdAt);
  audit(req.user.id, 'create', 'note', id, `创建笔记：${title}`);
  res.json({ ok: true, id });
});

app.get('/api/notes/:id', requireAuth, (req, res) => {
  const note = db.prepare(`
    SELECT n.*, creator.display_name AS creator_name, updater.display_name AS updater_name,
      folder.name AS folder_name
    FROM notes n
    JOIN users creator ON creator.id = n.created_by
    LEFT JOIN users updater ON updater.id = n.updated_by
    LEFT JOIN folders folder ON folder.id = n.folder_id
    WHERE n.id = ?
  `).get(req.params.id);
  if (!note) return res.status(404).json({ error: '笔记不存在' });
  res.json({ note, html_preview: renderMarkdown(note.content) });
});

app.put('/api/notes/:id', requireAuth, (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: '笔记不存在' });
  const title = req.body.title !== undefined ? safeText(req.body.title, note.title).slice(0, 160) : note.title;
  const content = req.body.content !== undefined ? String(req.body.content).slice(0, 1024 * 1024) : note.content;
  db.prepare('UPDATE notes SET title = ?, content = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(title, content, req.user.id, now(), note.id);
  audit(req.user.id, 'update', 'note', note.id, `保存笔记：${title}`);
  io.to(`note:${note.id}`).emit('note:saved', { id: note.id, title, updated_by: req.user.display_name, updated_at: now() });
  res.json({ ok: true });
});

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.use((socket, next) => {
  const userId = socket.request.session && socket.request.session.userId;
  if (!userId) return next(new Error('unauthorized'));
  const user = db.prepare('SELECT id, username, display_name, role, active FROM users WHERE id = ?').get(userId);
  if (!user || user.active !== 1) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', socket => {
  socket.on('note:join', payload => {
    const noteId = safeText(payload && payload.id);
    if (!noteId || !db.prepare('SELECT id FROM notes WHERE id = ?').get(noteId)) return;
    socket.join(`note:${noteId}`);
    socket.to(`note:${noteId}`).emit('note:presence', { message: `${socket.user.display_name} 加入编辑`, user: socket.user.display_name });
  });

  socket.on('note:edit', payload => {
    const noteId = safeText(payload && payload.id);
    const content = typeof payload.content === 'string' ? payload.content : '';
    if (!noteId || !db.prepare('SELECT id FROM notes WHERE id = ?').get(noteId)) return;
    socket.to(`note:${noteId}`).emit('note:remote-edit', { id: noteId, content, editor: socket.user.display_name });
  });

  socket.on('note:save', payload => {
    const noteId = safeText(payload && payload.id);
    const content = typeof payload.content === 'string' ? payload.content.slice(0, 1024 * 1024) : '';
    const title = safeText(payload && payload.title, '未命名笔记').slice(0, 160);
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
    if (!note) return;
    const updatedAt = now();
    db.prepare('UPDATE notes SET title = ?, content = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(title, content, socket.user.id, updatedAt, noteId);
    socket.to(`note:${noteId}`).emit('note:saved', { id: noteId, title, updated_by: socket.user.display_name, updated_at: updatedAt });
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在，请确认后端已重启到最新版本' });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: `上传失败：${err.message}` });
  if (req.path && req.path.startsWith('/api/')) return res.status(500).json({ error: '服务器内部错误' });
  res.status(500).send('服务器内部错误');
});

server.listen(PORT, HOST, () => {
  console.log(`实验室管理平台已启动：http://${HOST}:${PORT}`);
  if (process.env.PUBLIC_URL) {
    console.log(`公网访问地址：${process.env.PUBLIC_URL}`);
  } else {
    console.log('局域网访问时请使用服务器的内网 IP，例如：http://192.168.x.x:' + PORT);
  }
});
