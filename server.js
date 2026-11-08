const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();

// CORS Configuration
const allowedOrigins = [
  'https://nihuul-frontend.vercel.app',
  'http://localhost:3001',
  'http://localhost:3000',
  'http://localhost:3002',
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin,X-Requested-With,Content-Type,Accept,Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// ✅ Local: SQLite | Production: PostgreSQL
let db;
let isPostgres = false;

if (process.env.DATABASE_URL) {
  // Production: PostgreSQL
  const { Pool } = require('pg');
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  isPostgres = true;
  console.log('📡 Using PostgreSQL (Production)');
} else {
  // Local: SQLite
  db = new Database('./building.db');
  console.log('💾 Using SQLite (Local)');
}

const SECRET_KEY = 'your-secret-key-change-this';

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// Email via Resend (HTTPS API)
// Railway blocks outbound SMTP ports, so nodemailer/Gmail times out there.
// Resend sends over plain HTTPS, which is never blocked.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'ועד בית מצפה 47 <onboarding@resend.dev>';

async function sendEmail(toEmail, subject, html) {
  // Roster placeholders have fake addresses and no login; never send them email
  if (!toEmail || toEmail.endsWith('@roster.local')) return false;

  if (!RESEND_API_KEY) {
    console.error('❌ RESEND_API_KEY is not set - email not sent to', toEmail);
    return false;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({ from: EMAIL_FROM, to: [toEmail], subject, html }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('❌ Resend rejected the email to', toEmail, '-', response.status, detail);
      return false;
    }

    console.log('✅ Email sent to', toEmail);
    return true;
  } catch (err) {
    console.error('❌ Failed to send email to', toEmail, '-', err.message);
    return false;
  }
}

async function sendApprovalEmail(toEmail, fullName) {
  await sendEmail(
    toEmail,
    'הבקשה שלך אושרה',
    `
      <div dir="rtl" style="font-family: Arial, sans-serif;">
        <h2>שלום ${fullName},</h2>
        <p>הבקשה שלך להצטרפות למערכת ניהול הבניין אושרה על ידי ראש הוועד.</p>
        <p>כעת תוכל/י להתחבר למערכת עם כתובת המייל והסיסמה שנרשמו בהרשמה.</p>
      </div>
    `
  );
}

async function sendMessageEmail(toEmail, fullName, subject, content) {
  await sendEmail(
    toEmail,
    `הודעה מוועד הבית: ${subject}`,
    `
      <div dir="rtl" style="font-family: Arial, sans-serif;">
        <h2>שלום ${fullName},</h2>
        <h3>${subject}</h3>
        <p style="white-space: pre-wrap;">${content}</p>
        <hr>
        <p>ניתן לצפות בהודעה גם במערכת ניהול הבניין.</p>
      </div>
    `
  );
}

// Converts SQLite-style "?" placeholders to PostgreSQL-style "$1, $2, ..."
// Queries that already use $1 contain no "?" and pass through unchanged.
function toPg(query) {
  let i = 0;
  return query.replace(/\?/g, () => `$${++i}`);
}

// Helper function for database queries (works for both SQLite and PostgreSQL)
async function dbQuery(query, params = []) {
  if (isPostgres) {
    const result = await db.query(toPg(query), params);
    return result.rows;
  } else {
    // SQLite
    const stmt = db.prepare(query);
    if (query.trim().toUpperCase().startsWith('SELECT')) {
      return stmt.all(...params);
    } else {
      stmt.run(...params);
      return { success: true };
    }
  }
}

// Helper for single result
async function dbQueryOne(query, params = []) {
  if (isPostgres) {
    const result = await db.query(toPg(query), params);
    return result.rows[0];
  } else {
    const stmt = db.prepare(query);
    return stmt.get(...params);
  }
}

function verifyToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid token' });
    req.user = decoded;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.user_type !== 'admin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
}

// Initialize Database
function initDatabase() {
  try {
    if (!isPostgres) {
      // SQLite initialization
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          full_name TEXT NOT NULL,
          apartment_number TEXT,
          phone TEXT,
          user_type TEXT DEFAULT 'resident',
          is_approved INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS maintenance_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          title TEXT,
          description TEXT,
          status TEXT DEFAULT 'new',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          year INTEGER,
          month INTEGER,
          amount REAL,
          status TEXT DEFAULT 'pending',
          proof_file_path TEXT,
          proof_notes TEXT,
          reject_reason TEXT,
          details TEXT,
          due_date TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS announcements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          admin_id INTEGER,
          title TEXT,
          content TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (admin_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS votes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          admin_id INTEGER NOT NULL,
          title TEXT,
          description TEXT,
          status TEXT DEFAULT 'open',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (admin_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS vote_options (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vote_id INTEGER NOT NULL,
          option_text TEXT,
          vote_count INTEGER DEFAULT 0,
          FOREIGN KEY (vote_id) REFERENCES votes(id)
        );

        CREATE TABLE IF NOT EXISTS votes_cast (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vote_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          FOREIGN KEY (vote_id) REFERENCES votes(id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          sender_type TEXT DEFAULT 'resident',
          subject TEXT,
          content TEXT,
          status TEXT DEFAULT 'unread',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          maintenance_fee REAL DEFAULT 0,
          electricity REAL DEFAULT 0,
          cleaning REAL DEFAULT 0,
          gardening REAL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
    } else {
      // PostgreSQL initialization (existing code)
      const createQueries = [
        `CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          full_name VARCHAR(255) NOT NULL,
          apartment_number VARCHAR(50),
          phone VARCHAR(20),
          user_type VARCHAR(50) DEFAULT 'resident',
          is_approved INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS maintenance_requests (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          title VARCHAR(255),
          description TEXT,
          status VARCHAR(50) DEFAULT 'new',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS payments (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          year INTEGER,
          month INTEGER,
          amount DECIMAL(10, 2),
          status VARCHAR(50) DEFAULT 'pending',
          proof_file_path VARCHAR(255),
          proof_notes TEXT,
          reject_reason TEXT,
          details TEXT,
          due_date DATE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS announcements (
          id SERIAL PRIMARY KEY,
          admin_id INTEGER,
          title VARCHAR(255),
          content TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (admin_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS votes (
          id SERIAL PRIMARY KEY,
          admin_id INTEGER NOT NULL,
          title VARCHAR(255),
          description TEXT,
          status VARCHAR(50) DEFAULT 'open',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (admin_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS vote_options (
          id SERIAL PRIMARY KEY,
          vote_id INTEGER NOT NULL,
          option_text VARCHAR(255),
          vote_count INTEGER DEFAULT 0,
          FOREIGN KEY (vote_id) REFERENCES votes(id)
        )`,
        `CREATE TABLE IF NOT EXISTS votes_cast (
          id SERIAL PRIMARY KEY,
          vote_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          FOREIGN KEY (vote_id) REFERENCES votes(id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          sender_type VARCHAR(20) DEFAULT 'resident',
          subject VARCHAR(255),
          content TEXT,
          status VARCHAR(20) DEFAULT 'unread',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )`,
        `CREATE TABLE IF NOT EXISTS expenses (
          id SERIAL PRIMARY KEY,
          maintenance_fee DECIMAL(10, 2) DEFAULT 0,
          electricity DECIMAL(10, 2) DEFAULT 0,
          cleaning DECIMAL(10, 2) DEFAULT 0,
          gardening DECIMAL(10, 2) DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
      ];

      createQueries.forEach(q => db.query(q).catch(() => { }));
    }

    // Migration: payments.due_date was added later, so existing tables need it.
    // CREATE TABLE IF NOT EXISTS never alters a table that already exists.
    if (isPostgres) {
      db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS due_date DATE`)
        .then(() => console.log('✅ payments.due_date ready'))
        .catch((e) => console.error('due_date migration:', e.message));
    } else {
      try {
        const cols = db.prepare(`PRAGMA table_info(payments)`).all();
        if (!cols.some((c) => c.name === 'due_date')) {
          db.exec(`ALTER TABLE payments ADD COLUMN due_date TEXT`);
          console.log('✅ payments.due_date added');
        }
      } catch (e) {
        console.error('due_date migration:', e.message);
      }
    }

    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

// AUTH
app.post('/api/auth/login', async (req, res) => {
  try {
    await ensureProfileColumn();
    const { email, password } = req.body;
    const hash = crypto.createHash('sha256').update(password).digest('hex');

    const rows = await dbQuery(
      'SELECT * FROM users WHERE email = ? AND password_hash = ?',
      [email, hash]
    );
    const user = rows[0];

    if (!user) return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
    if (user.user_type === 'resident' && user.is_approved !== 1) {
      return res.status(403).json({ error: 'החשבון שלך ממתין לאישור' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, user_type: user.user_type },
      SECRET_KEY,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        apartment: user.apartment_number,
        user_type: user.user_type,
        must_update: user.user_type === 'admin' && !user.profile_completed,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { email, password, full_name, apartment, phone } = req.body;
    if (!email || !password || !full_name || !apartment) {
      return res.status(400).json({ error: 'חסרים שדות חובה' });
    }

    const aptNumber = String(apartment).trim();
    const claimHash = crypto.createHash('sha256').update(password).digest('hex');

    // A roster placeholder (no password yet) is claimed, found by email or by apartment.
    const byEmail = await dbQuery('SELECT id, password_hash FROM users WHERE email = ?', [email]);
    if (byEmail.length > 0 && byEmail[0].password_hash !== '') {
      return res.status(400).json({ error: 'אימייל כבר קיים' });
    }
    let claimId = byEmail.length > 0 ? byEmail[0].id : null;
    if (!claimId) {
      const byApt = await dbQuery(`SELECT id FROM users WHERE apartment_number = ? AND password_hash = ''`, [aptNumber]);
      if (byApt.length > 0) claimId = byApt[0].id;
    }
    if (claimId) {
      await dbQuery(
        'UPDATE users SET email = ?, password_hash = ?, full_name = ?, phone = ?, apartment_number = ?, is_approved = 0 WHERE id = ?',
        [email, claimHash, full_name, phone || null, aptNumber, claimId]
      );
      return res.json({ success: true, id: claimId, claimed: true });
    }

    const hash = crypto.createHash('sha256').update(password).digest('hex');

    if (isPostgres) {
      const result = await dbQuery(
        `INSERT INTO users (email, password_hash, full_name, apartment_number, phone, user_type, is_approved) 
         VALUES ($1, $2, $3, $4, $5, 'resident', 0) RETURNING id`,
        [email, hash, full_name, apartment, phone || null]
      );
      res.json({ success: true, id: result[0].id });
    } else {
      const stmt = db.prepare(
        `INSERT INTO users (email, password_hash, full_name, apartment_number, phone, user_type, is_approved) 
         VALUES (?, ?, ?, ?, ?, 'resident', 0)`
      );
      const info = stmt.run(email, hash, full_name, apartment, phone || null);
      res.json({ success: true, id: info.lastID });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MAINTENANCE
let maintenanceArchiveReady = false;
async function ensureMaintenanceArchiveColumn() {
  if (maintenanceArchiveReady) return;
  if (isPostgres) {
    await db.query('ALTER TABLE maintenance_requests ADD COLUMN IF NOT EXISTS archived INTEGER DEFAULT 0');
  } else {
    const cols = db.prepare('PRAGMA table_info(maintenance_requests)').all();
    if (!cols.some((c) => c.name === 'archived')) {
      db.exec('ALTER TABLE maintenance_requests ADD COLUMN archived INTEGER DEFAULT 0');
    }
  }
  maintenanceArchiveReady = true;
}

app.get('/api/maintenance', verifyToken, async (req, res) => {
  try {
    let rows;
    if (req.user.user_type === 'admin') {
      await ensureMaintenanceArchiveColumn();
      rows = await dbQuery(
        `SELECT m.*, u.full_name, u.apartment_number as apartment FROM maintenance_requests m 
         JOIN users u ON m.user_id = u.id WHERE NOT (COALESCE(m.archived, 0) = 1 OR m.created_at < ?) ORDER BY m.updated_at DESC`,
        [archiveCutoffDate()]
      );
    } else {
      rows = await dbQuery(
        `SELECT m.*, u.full_name, u.apartment_number as apartment FROM maintenance_requests m 
         JOIN users u ON m.user_id = u.id WHERE m.user_id = ? ORDER BY m.updated_at DESC`,
        [req.user.id]
      );
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/maintenance', verifyToken, async (req, res) => {
  try {
    const { description, category } = req.body;
    const title = category || 'בקשת תחזוקה';

    if (isPostgres) {
      const result = await dbQuery(
        `INSERT INTO maintenance_requests (user_id, title, description, status, created_at, updated_at) 
         VALUES ($1, $2, $3, 'new', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
        [req.user.id, title, description]
      );
      res.json({ success: true, id: result[0].id });
    } else {
      const stmt = db.prepare(
        `INSERT INTO maintenance_requests (user_id, title, description, status) 
         VALUES (?, ?, ?, 'new')`
      );
      const info = stmt.run(req.user.id, title, description);
      res.json({ success: true, id: info.lastID });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN - ARCHIVE (removes from the main list, keeps the record)
// ---- ARCHIVE (all lists). Records older than 5 years are archived automatically. ----
function archiveCutoffDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
}
function rowDateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
const archiveColumnReady = new Set();
let profileColumnReady = false;
async function ensureProfileColumn() {
  if (profileColumnReady) return;
  if (isPostgres) {
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_completed INTEGER DEFAULT 0');
  } else {
    const cols = db.prepare('PRAGMA table_info(users)').all();
    if (!cols.some((c) => c.name === 'profile_completed')) {
      db.exec('ALTER TABLE users ADD COLUMN profile_completed INTEGER DEFAULT 0');
    }
  }
  profileColumnReady = true;
}

async function ensureArchiveColumn(table) {
  if (archiveColumnReady.has(table)) return;
  if (isPostgres) {
    await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS archived INTEGER DEFAULT 0`);
  } else {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === 'archived')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN archived INTEGER DEFAULT 0`);
    }
  }
  archiveColumnReady.add(table);
}
const ARCHIVE_KINDS = {
  expenses: { table: 'expense_entries', dateCol: 'expense_date', ensure: () => ensureExpenseEntriesTable() },
  withdrawals: { table: 'cash_withdrawals', dateCol: 'withdrawal_date', ensure: () => ensureCashWithdrawalsTables() },
  announcements: { table: 'announcements', dateCol: 'created_at' },
  votes: { table: 'votes', dateCol: 'created_at' },
  messages: { table: 'messages', dateCol: 'created_at', extraWhere: "sender_type = 'resident'" },
  maintenance: { table: 'maintenance_requests', dateCol: 'created_at' },
  suppliers: { table: 'suppliers', dateCol: 'created_at', ensure: () => ensureSuppliersTable() },
};
async function prepareArchiveKind(cfg) {
  if (cfg.ensure) await cfg.ensure();
  await ensureArchiveColumn(cfg.table);
}

app.get('/api/admin/archive/:kind', verifyToken, requireAdmin, async (req, res) => {
  try {
    const cfg = ARCHIVE_KINDS[req.params.kind];
    if (!cfg) return res.status(404).json({ error: 'סוג ארכיון לא מוכר' });
    await prepareArchiveKind(cfg);
    const cutoff = archiveCutoffDate();
    const extra = cfg.extraWhere ? ` AND ${cfg.extraWhere}` : '';
    const rows = await dbQuery(
      `SELECT * FROM ${cfg.table} WHERE (COALESCE(archived, 0) = 1 OR ${cfg.dateCol} < ?)${extra} ORDER BY ${cfg.dateCol} DESC`,
      [cutoff]
    );
    res.json(rows.map((r) => {
      const archived = Number(r.archived) === 1;
      const old = rowDateOnly(r[cfg.dateCol]) < cutoff;
      return { ...r, archived, old, restorable: archived && !old };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/archive/:kind/:id/archive', verifyToken, requireAdmin, async (req, res) => {
  try {
    const cfg = ARCHIVE_KINDS[req.params.kind];
    if (!cfg) return res.status(404).json({ error: 'סוג ארכיון לא מוכר' });
    await prepareArchiveKind(cfg);
    await dbQuery(`UPDATE ${cfg.table} SET archived = 1 WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/archive/:kind/:id/unarchive', verifyToken, requireAdmin, async (req, res) => {
  try {
    const cfg = ARCHIVE_KINDS[req.params.kind];
    if (!cfg) return res.status(404).json({ error: 'סוג ארכיון לא מוכר' });
    await prepareArchiveKind(cfg);
    const row = await dbQueryOne(`SELECT ${cfg.dateCol} AS d FROM ${cfg.table} WHERE id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'הרשומה לא נמצאה' });
    if (rowDateOnly(row.d) < archiveCutoffDate()) {
      return res.status(400).json({ error: 'רשומה מלפני 5 שנים לא ניתנת להחזרה למסך הראשי' });
    }
    await dbQuery(`UPDATE ${cfg.table} SET archived = 0 WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/archive/:kind/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const cfg = ARCHIVE_KINDS[req.params.kind];
    if (!cfg) return res.status(404).json({ error: 'סוג ארכיון לא מוכר' });
    await prepareArchiveKind(cfg);
    const row = await dbQueryOne(`SELECT archived, ${cfg.dateCol} AS d FROM ${cfg.table} WHERE id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'הרשומה לא נמצאה' });
    const archived = Number(row.archived) === 1;
    const old = rowDateOnly(row.d) < archiveCutoffDate();
    if (!archived && !old) {
      return res.status(400).json({ error: 'יש להעביר את הרשומה לארכיון לפני מחיקה' });
    }
    if (req.params.kind === 'withdrawals') {
      const linked = await dbQueryOne('SELECT COUNT(*) AS c FROM expense_entries WHERE withdrawal_id = ?', [req.params.id]);
      if (Number(linked.c) > 0) {
        return res.status(400).json({ error: 'למשיכה יש הוצאות משויכות - מחק אותן קודם' });
      }
    }
    await dbQuery(`DELETE FROM ${cfg.table} WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- SUPPLIERS (נותני שירות) ----
let suppliersReady = false;
async function ensureSuppliersTable() {
  if (suppliersReady) return;
  await ensureExpenseEntriesTable();
  if (isPostgres) {
    await db.query(`CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY,
      business_name TEXT NOT NULL,
      service_type TEXT,
      address TEXT,
      phone TEXT,
      mobile TEXT,
      email TEXT,
      bank_name TEXT,
      bank_branch TEXT,
      bank_account TEXT,
      notes TEXT,
      archived INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.query('ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS supplier_id INTEGER');
  } else {
    db.exec(`CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_name TEXT NOT NULL,
      service_type TEXT,
      address TEXT,
      phone TEXT,
      mobile TEXT,
      email TEXT,
      bank_name TEXT,
      bank_branch TEXT,
      bank_account TEXT,
      notes TEXT,
      archived INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    const cols = db.prepare('PRAGMA table_info(expense_entries)').all();
    if (!cols.some((c) => c.name === 'supplier_id')) {
      db.exec('ALTER TABLE expense_entries ADD COLUMN supplier_id INTEGER');
    }
  }
  suppliersReady = true;
}

function supplierFields(body) {
  const b = body || {};
  const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
  return {
    business_name: clean(b.business_name),
    service_type: clean(b.service_type),
    address: clean(b.address),
    phone: clean(b.phone),
    mobile: clean(b.mobile),
    email: clean(b.email),
    bank_name: clean(b.bank_name),
    bank_branch: clean(b.bank_branch),
    bank_account: clean(b.bank_account),
    notes: clean(b.notes),
  };
}

app.get('/api/admin/suppliers', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureSuppliersTable();
    await ensureArchiveColumn('suppliers');
    const rows = await dbQuery(
      `SELECT s.*,
        (SELECT COUNT(*) FROM expense_entries e WHERE e.supplier_id = s.id) AS expense_count,
        (SELECT COALESCE(SUM(e.amount), 0) FROM expense_entries e WHERE e.supplier_id = s.id) AS expense_total
       FROM suppliers s
       WHERE NOT (COALESCE(s.archived, 0) = 1 OR s.created_at < ?)
       ORDER BY s.business_name`,
      [archiveCutoffDate()]
    );
    res.json(rows.map((r) => ({ ...r, expense_count: Number(r.expense_count) || 0, expense_total: Number(r.expense_total) || 0 })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/suppliers', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureSuppliersTable();
    const f = supplierFields(req.body);
    if (!f.business_name) return res.status(400).json({ error: 'חובה להזין שם עסק' });
    await dbQuery(
      'INSERT INTO suppliers (business_name, service_type, address, phone, mobile, email, bank_name, bank_branch, bank_account, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [f.business_name, f.service_type, f.address, f.phone, f.mobile, f.email, f.bank_name, f.bank_branch, f.bank_account, f.notes]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/suppliers/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureSuppliersTable();
    const f = supplierFields(req.body);
    if (!f.business_name) return res.status(400).json({ error: 'חובה להזין שם עסק' });
    await dbQuery(
      'UPDATE suppliers SET business_name = ?, service_type = ?, address = ?, phone = ?, mobile = ?, email = ?, bank_name = ?, bank_branch = ?, bank_account = ?, notes = ? WHERE id = ?',
      [f.business_name, f.service_type, f.address, f.phone, f.mobile, f.email, f.bank_name, f.bank_branch, f.bank_account, f.notes, req.params.id]
    );
    // keep the name shown on linked expenses in sync
    await dbQuery('UPDATE expense_entries SET supplier = ? WHERE supplier_id = ?', [f.business_name, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/suppliers/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureSuppliersTable();
    const linked = await dbQueryOne('SELECT COUNT(*) AS c FROM expense_entries WHERE supplier_id = ?', [req.params.id]);
    if (Number(linked.c) > 0) {
      return res.status(400).json({ error: 'לספק יש הוצאות משויכות - העבר אותו לארכיון במקום למחוק' });
    }
    await dbQuery('DELETE FROM suppliers WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN - FULL BACKUP and WIPE (keeps the users table: residents and admin accounts)
const BACKUP_TABLES = ['users', 'payments', 'announcements', 'votes', 'vote_options', 'votes_cast', 'messages', 'maintenance_requests', 'expense_entries', 'cash_withdrawals', 'bank_imports'];
const WIPE_ORDER = ['votes_cast', 'vote_options', 'votes', 'messages', 'maintenance_requests', 'payments', 'expense_entries', 'cash_withdrawals', 'announcements', 'bank_imports'];

app.get('/api/admin/backup-all', verifyToken, requireAdmin, async (req, res) => {
  try {
    const tables = {};
    for (const t of BACKUP_TABLES) {
      try {
        tables[t] = await dbQuery(`SELECT * FROM ${t}`, []);
      } catch (e) {
        tables[t] = [];
      }
    }
    res.json({ exported_at: new Date().toISOString(), tables });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/wipe-data', verifyToken, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const dryRun = body.dryRun !== false;
    if (!dryRun && body.confirm !== 'WIPE') {
      return res.status(400).json({ error: 'חסר אישור מחיקה' });
    }
    const counts = {};
    for (const t of WIPE_ORDER) {
      try {
        const row = await dbQueryOne(`SELECT COUNT(*) AS c FROM ${t}`, []);
        counts[t] = Number(row.c) || 0;
      } catch (e) {
        counts[t] = 0;
      }
    }
    const errors = [];
    if (!dryRun) {
      for (const t of WIPE_ORDER) {
        try {
          await dbQuery(`DELETE FROM ${t}`, []);
        } catch (e) {
          if (!/no such table|does not exist/i.test(e.message)) errors.push(t + ': ' + e.message);
        }
      }
    }
    if (errors.length) return res.status(500).json({ error: errors.join(' | '), counts });
    res.json({ success: true, dryRun, counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/archive-export/:kind', verifyToken, requireAdmin, async (req, res) => {
  try {
    const cfg = ARCHIVE_KINDS[req.params.kind];
    if (!cfg) return res.status(404).json({ error: 'סוג ארכיון לא מוכר' });
    await prepareArchiveKind(cfg);
    const extra = cfg.extraWhere ? ` WHERE ${cfg.extraWhere}` : '';
    const rows = await dbQuery(`SELECT * FROM ${cfg.table}${extra} ORDER BY ${cfg.dateCol} DESC`, []);
    const cutoff = archiveCutoffDate();
    res.json(rows.map((r) => {
      const archived = Number(r.archived) === 1;
      const old = rowDateOnly(r[cfg.dateCol]) < cutoff;
      const status = archived ? 'בארכיון (ידני)' : old ? 'ישן (מעל 5 שנים)' : 'פעיל';
      return { ...r, archived, old, status };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/maintenance/archived', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureMaintenanceArchiveColumn();
    const rows = await dbQuery(
      `SELECT m.*, u.full_name, u.apartment_number as apartment FROM maintenance_requests m
       JOIN users u ON m.user_id = u.id WHERE COALESCE(m.archived, 0) = 1 ORDER BY m.updated_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/maintenance/:id/archive', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureMaintenanceArchiveColumn();
    await dbQuery(`UPDATE maintenance_requests SET archived = 1 WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/maintenance/:id/unarchive', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureMaintenanceArchiveColumn();
    await dbQuery(`UPDATE maintenance_requests SET archived = 0 WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/maintenance/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await dbQuery(
      `UPDATE maintenance_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN - ALL RESIDENTS
// Admin edits a resident's details. Email must stay unique across users.
app.put('/api/admin/residents/:id/details', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { full_name, email, phone, apartment } = req.body;
    if (!full_name || !email || !apartment) {
      return res.status(400).json({ error: 'חסרים שדות חובה' });
    }
    const mail = String(email).trim();
    const clash = await dbQuery('SELECT id FROM users WHERE email = ? AND id <> ?', [mail, req.params.id]);
    if (clash.length > 0) return res.status(400).json({ error: 'אימייל כבר קיים אצל דייר אחר' });

    await dbQuery(
      `UPDATE users SET full_name = ?, email = ?, phone = ?, apartment_number = ? WHERE id = ? AND user_type = 'resident'`,
      [String(full_name).trim(), mail, phone || null, String(apartment).trim(), req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- BANK IMPORT (Poalim "תנועות בחשבון") ----------
// Credits from the bank file are matched to residents, and their open charges are marked
// paid only after the admin approves. Each credit is stored by fingerprint, so a re-upload
// of the same file never marks anything twice.
let bankTableReady = false;
async function ensureBankTable() {
  if (bankTableReady) return;
  if (isPostgres) {
    await db.query(`CREATE TABLE IF NOT EXISTS bank_imports (
      id SERIAL PRIMARY KEY,
      fingerprint TEXT UNIQUE NOT NULL,
      tx_date TEXT,
      amount DECIMAL(10, 2),
      description TEXT,
      user_id INTEGER,
      charge_ids TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  } else {
    db.exec(`CREATE TABLE IF NOT EXISTS bank_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT UNIQUE NOT NULL,
      tx_date TEXT,
      amount REAL,
      description TEXT,
      user_id INTEGER,
      charge_ids TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
  bankTableReady = true;
}

function bankNormalize(s) {
  return String(s || '').replace(/[^֐-׿a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Finds the resident a credit belongs to: by "דירה N" in the text, then by name words.
// Returns null when unsure, so the admin picks the resident by hand.
function findResidentForCredit(residents, description, reference) {
  const text = bankNormalize(`${description} ${reference}`);
  const m = text.match(/דירה\s*(\d+)/);
  let pool = residents;
  if (m) pool = residents.filter((r) => String(r.apartment_number).trim() === m[1]);
  if (m && pool.length === 1) return pool[0];

  const scored = pool
    .map((r) => {
      const words = bankNormalize(r.full_name).split(' ').filter((w) => w.length >= 2);
      return { r, score: words.filter((w) => text.includes(w)).length };
    })
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0 || scored[0].score < 2) return null;
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;
  return scored[0].r;
}

// Oldest open charges whose sum equals the amount exactly (one month, or several paid at once).
async function chargesCoveringAmount(userId, amount) {
  const open = await dbQuery(
    `SELECT id, amount FROM payments WHERE user_id = ? AND status <> 'paid' ORDER BY year, month, id`,
    [userId]
  );
  let sum = 0;
  const ids = [];
  for (const p of open) {
    sum += Number(p.amount) || 0;
    ids.push(p.id);
    if (Math.abs(sum - amount) < 0.01) return { ids, exact: true };
    if (sum > amount + 0.01) break;
  }
  return { ids: [], exact: false };
}

// Body: { rows: [{ date, amount, description, reference, sender }] } - credits only.
// Read-only: nothing is marked paid here.
app.post('/api/admin/bank-import/match', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureBankTable();
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const residents = await dbQuery(`SELECT id, full_name, apartment_number FROM users WHERE user_type = 'resident'`);
    const results = [];
    for (const r of rows) {
      const amount = Number(r.amount);
      if (!(amount > 0)) continue;
      const fingerprint = `${r.date}|${amount}|${r.reference}`;
      const base = { fingerprint, date: r.date, amount, description: r.description || '', reference: r.reference || '', sender: r.sender || '' };

      const dup = await dbQuery('SELECT id FROM bank_imports WHERE fingerprint = ?', [fingerprint]);
      if (dup.length > 0) { results.push({ ...base, status: 'duplicate' }); continue; }

      const resident = findResidentForCredit(residents, r.description, r.reference);
      if (!resident) { results.push({ ...base, status: 'unmatched' }); continue; }

      const { ids, exact } = await chargesCoveringAmount(resident.id, amount);
      results.push({
        ...base,
        status: exact ? 'matched' : 'partial',
        user_id: resident.id,
        full_name: resident.full_name,
        apartment: resident.apartment_number,
        charge_ids: ids,
      });
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Body: { items: [{ date, amount, reference, description, user_id }] }
// Marks the matching open charges as paid and records the fingerprint.
app.post('/api/admin/bank-import/apply', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureBankTable();
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    let applied = 0;
    const skipped = [];
    for (const it of items) {
      const amount = Number(it.amount);
      const fingerprint = `${it.date}|${amount}|${it.reference}`;
      if (!it.user_id) { skipped.push({ fingerprint, reason: 'לא נבחר דייר' }); continue; }

      const dup = await dbQuery('SELECT id FROM bank_imports WHERE fingerprint = ?', [fingerprint]);
      if (dup.length > 0) { skipped.push({ fingerprint, reason: 'התשלום כבר יובא' }); continue; }

      const { ids, exact } = await chargesCoveringAmount(Number(it.user_id), amount);
      if (!exact) {
        skipped.push({ fingerprint, reason: 'הסכום לא תואם חיוב פתוח אחד או יותר של הדייר' });
        continue;
      }
      await ensurePaymentNoteColumn();
      const covered = ids.length
        ? await dbQuery(
          `SELECT year, month FROM payments WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY year, month`,
          ids
        )
        : [];
      const monthLabels = covered.map((c) => `${MONTH_NAMES[c.month - 1]} ${c.year}`);
      const userNote = String(it.note || '').trim();
      const noteText = `שולם ${String(it.date)}: ${monthLabels.join(', ')}${userNote ? ' | ' + userNote : ''}`;
      for (const id of ids) {
        await dbQuery(`UPDATE payments SET status = 'paid', admin_note = ? WHERE id = ?`, [noteText, id]);
      }
      await dbQuery(
        'INSERT INTO bank_imports (fingerprint, tx_date, amount, description, user_id, charge_ids) VALUES (?, ?, ?, ?, ?, ?)',
        [fingerprint, String(it.date), amount, String(it.description || ''), Number(it.user_id), ids.join(',')]
      );
      applied++;
    }
    res.json({ success: true, applied, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/bank-import/reset  { dryRun }
// Undoes everything the bank import did to payments: every charge it marked paid goes back to pending
// and its note is cleared; the bank_imports log is emptied. Expenses and withdrawals are reset by the script.
app.post('/api/admin/bank-import/reset', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureBankTable();
    await ensurePaymentNoteColumn();
    const imports = await dbQuery('SELECT id, charge_ids FROM bank_imports', []);
    const chargeIds = [];
    imports.forEach((row) => {
      String(row.charge_ids || '')
        .split(',')
        .map((s) => Number(s))
        .filter((n) => n > 0)
        .forEach((n) => { if (!chargeIds.includes(n)) chargeIds.push(n); });
    });
    const dryRun = !!(req.body && req.body.dryRun === true);
    if (!dryRun) {
      for (const id of chargeIds) {
        await dbQuery("UPDATE payments SET status = 'pending', admin_note = NULL WHERE id = ?", [id]);
      }
      await dbQuery('DELETE FROM bank_imports', []);
    }
    res.json({ success: true, dryRun, imports: imports.length, payments: chargeIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/payments/:id/note  { note }  (empty note clears it)
app.put('/api/admin/payments/:id/note', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensurePaymentNoteColumn();
    const note = String(req.body.note || '').trim();
    await dbQuery('UPDATE payments SET admin_note = ? WHERE id = ?', [note || null, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/reports/payments?year=2026  - every charge of the year with its status and note
app.get('/api/admin/reports/payments', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensurePaymentNoteColumn();
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const rows = await dbQuery(
      `SELECT p.id, p.year, p.month, p.amount, p.status, p.admin_note, u.full_name, u.apartment_number AS apartment
       FROM payments p JOIN users u ON p.user_id = u.id
       WHERE p.year = ? AND u.user_type = 'resident'
       ORDER BY u.apartment_number, p.month`,
      [year]
    );
    res.json({
      year,
      rows: rows.map((r) => ({ ...r, amount: Number(r.amount), note: r.admin_note || '' })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- EXPENSE ENTRIES (one row per invoice) ----------
const EXPENSE_CATEGORIES = [
  'חשמל', 'ניקיון', 'גינון', 'אינסטלציה', 'שיפוצים', 'מעלית', 'הדברה',
  'ביטוח בניין', 'אלומניום - דלתות', 'בטיחות והנדסה', 'דמי ניהול ועמלות בנק', 'שונות',
];
let expenseEntriesReady = false;
async function ensureExpenseEntriesTable() {
  if (expenseEntriesReady) return;
  if (isPostgres) {
    await db.query(`CREATE TABLE IF NOT EXISTS expense_entries (
      id SERIAL PRIMARY KEY,
      expense_date TEXT NOT NULL,
      category TEXT NOT NULL,
      supplier TEXT,
      invoice_number TEXT,
      amount DECIMAL(10, 2) NOT NULL,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  } else {
    db.exec(`CREATE TABLE IF NOT EXISTS expense_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_date TEXT NOT NULL,
      category TEXT NOT NULL,
      supplier TEXT,
      invoice_number TEXT,
      amount REAL NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
  expenseEntriesReady = true;
}

// ---------- CASH WITHDRAWALS (משיכות מזומן) and the expenses paid from them ----------
let cashWithdrawalsReady = false;
async function ensureCashWithdrawalsTables() {
  if (cashWithdrawalsReady) return;
  await ensureExpenseEntriesTable();
  if (isPostgres) {
    await db.query(`CREATE TABLE IF NOT EXISTS cash_withdrawals (
      id SERIAL PRIMARY KEY,
      withdrawal_date TEXT NOT NULL,
      amount DECIMAL(10, 2) NOT NULL,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.query('ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS withdrawal_id INTEGER');
  } else {
    db.exec(`CREATE TABLE IF NOT EXISTS cash_withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      withdrawal_date TEXT NOT NULL,
      amount REAL NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    const cols = db.prepare('PRAGMA table_info(expense_entries)').all();
    if (!cols.some((c) => c.name === 'withdrawal_id')) {
      db.exec('ALTER TABLE expense_entries ADD COLUMN withdrawal_id INTEGER');
    }
  }
  cashWithdrawalsReady = true;
}
const round2 = (n) => Math.round(n * 100) / 100;

// GET /api/admin/cash-withdrawals - each withdrawal with its linked expenses and remaining balance
app.get('/api/admin/cash-withdrawals', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureCashWithdrawalsTables();
    await ensureArchiveColumn('cash_withdrawals');
    const withdrawals = await dbQuery('SELECT * FROM cash_withdrawals WHERE NOT (COALESCE(archived, 0) = 1 OR withdrawal_date < ?) ORDER BY withdrawal_date DESC, id DESC', [archiveCutoffDate()]);
    const linkedRows = await dbQuery(
      'SELECT * FROM expense_entries WHERE withdrawal_id IS NOT NULL ORDER BY expense_date, id', []
    );
    const result = withdrawals.map((w) => {
      const expenses = linkedRows
        .filter((e) => Number(e.withdrawal_id) === Number(w.id))
        .map((e) => ({ ...e, amount: Number(e.amount), expense_date: String(e.expense_date) }));
      const amount = Number(w.amount);
      const allocated = round2(expenses.reduce((sum, e) => sum + e.amount, 0));
      return { ...w, amount, allocated, remaining: round2(amount - allocated), expenses };
    });
    res.json({ withdrawals: result, categories: EXPENSE_CATEGORIES });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cash-withdrawals  { withdrawal_date, amount, notes }
app.post('/api/admin/cash-withdrawals', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureCashWithdrawalsTables();
    const { withdrawal_date, amount, notes } = req.body;
    const amt = Number(amount);
    if (!withdrawal_date || !/^\d{4}-\d{2}-\d{2}$/.test(withdrawal_date)) {
      return res.status(400).json({ error: 'תאריך לא תקין' });
    }
    if (!(amt > 0)) {
      return res.status(400).json({ error: 'סכום חייב להיות גדול מאפס' });
    }
    await dbQuery(
      'INSERT INTO cash_withdrawals (withdrawal_date, amount, notes) VALUES (?, ?, ?)',
      [withdrawal_date, amt, notes || null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/cash-withdrawals/:id - only when no expense is linked to it
app.delete('/api/admin/cash-withdrawals/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureCashWithdrawalsTables();
    const linked = await dbQuery('SELECT COUNT(*) AS n FROM expense_entries WHERE withdrawal_id = ?', [req.params.id]);
    if (Number(linked[0].n) > 0) {
      return res.status(400).json({ error: 'למשיכה יש הוצאות משויכות - מחק אותן קודם' });
    }
    await dbQuery('DELETE FROM cash_withdrawals WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cash-withdrawals/:id/expenses - an expense paid from this withdrawal (cannot exceed it)
app.post('/api/admin/cash-withdrawals/:id/expenses', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureCashWithdrawalsTables();
    const found = await dbQuery('SELECT * FROM cash_withdrawals WHERE id = ?', [req.params.id]);
    if (found.length === 0) {
      return res.status(404).json({ error: 'משיכה לא נמצאה' });
    }
    const { expense_date, category, supplier, invoice_number, amount, notes } = req.body;
    const amt = Number(amount);
    if (!expense_date || !/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
      return res.status(400).json({ error: 'תאריך לא תקין' });
    }
    if (!EXPENSE_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'קטגוריה לא תקינה' });
    }
    if (!(amt > 0)) {
      return res.status(400).json({ error: 'סכום חייב להיות גדול מאפס' });
    }
    const linked = await dbQuery('SELECT amount FROM expense_entries WHERE withdrawal_id = ?', [req.params.id]);
    const used = linked.reduce((sum, e) => sum + Number(e.amount), 0);
    const remaining = round2(Number(found[0].amount) - used);
    if (amt > remaining + 0.001) {
      return res.status(400).json({ error: `הסכום חורג מיתרת המשיכה (נותרו ₪${remaining.toFixed(2)})` });
    }
    await dbQuery(
      'INSERT INTO expense_entries (expense_date, category, supplier, invoice_number, amount, notes, withdrawal_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [expense_date, category, supplier || null, invoice_number || null, amt, notes || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/cash-balance?year=2026&opening=0
// Income = paid monthly charges (by charge month). Expenses = expense entries (by expense month).
app.get('/api/admin/cash-balance', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureExpenseEntriesTable();
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const opening = Number(req.query.opening) || 0;
    const round2 = (n) => Math.round(n * 100) / 100;

    const paid = await dbQuery(`SELECT month, amount FROM payments WHERE status = 'paid' AND year = ?`, [year]);
    const expenses = await dbQuery('SELECT expense_date, amount FROM expense_entries', []);

    const income = Array(13).fill(0);
    const spent = Array(13).fill(0);
    paid.forEach((p) => {
      const m = Number(p.month);
      if (m >= 1 && m <= 12) income[m] += Number(p.amount) || 0;
    });
    expenses.forEach((e) => {
      const [y, m] = String(e.expense_date).split('-').map(Number);
      if (y === year && m >= 1 && m <= 12) spent[m] += Number(e.amount) || 0;
    });

    let balance = opening;
    const rows = [];
    for (let m = 1; m <= 12; m++) {
      const net = income[m] - spent[m];
      balance += net;
      rows.push({
        month: m,
        income: round2(income[m]),
        expenses: round2(spent[m]),
        net: round2(net),
        balance: round2(balance),
      });
    }
    const totalIncome = income.reduce((a, b) => a + b, 0);
    const totalExpenses = spent.reduce((a, b) => a + b, 0);
    res.json({
      year,
      opening: round2(opening),
      rows,
      totals: {
        income: round2(totalIncome),
        expenses: round2(totalExpenses),
        net: round2(totalIncome - totalExpenses),
        balance: round2(balance),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/expense-entries', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureExpenseEntriesTable();
    await ensureArchiveColumn('expense_entries');
    const rows = await dbQuery('SELECT * FROM expense_entries WHERE NOT (COALESCE(archived, 0) = 1 OR expense_date < ?) ORDER BY expense_date DESC, id DESC', [archiveCutoffDate()]);
    res.json({
      categories: EXPENSE_CATEGORIES,
      entries: rows.map((r) => ({ ...r, amount: Number(r.amount), expense_date: String(r.expense_date) })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Body: { expense_date: 'YYYY-MM-DD', category, supplier, invoice_number, amount, notes }
app.post('/api/admin/expense-entries', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureExpenseEntriesTable();
    const { expense_date, category, supplier, supplier_id, invoice_number, amount, notes } = req.body;
    const amt = Number(amount);
    if (!expense_date || !/^\d{4}-\d{2}-\d{2}$/.test(expense_date)) {
      return res.status(400).json({ error: 'תאריך לא תקין' });
    }
    if (!EXPENSE_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'קטגוריה לא תקינה' });
    }
    if (!(amt > 0)) {
      return res.status(400).json({ error: 'סכום חייב להיות גדול מאפס' });
    }
    await ensureSuppliersTable();
    let supplierName = supplier || null;
    let supplierId = null;
    if (supplier_id) {
      const sup = await dbQueryOne('SELECT id, business_name FROM suppliers WHERE id = ?', [supplier_id]);
      if (!sup) return res.status(400).json({ error: 'הספק לא נמצא' });
      supplierId = sup.id;
      supplierName = sup.business_name;
    }
    await dbQuery(
      'INSERT INTO expense_entries (expense_date, category, supplier, supplier_id, invoice_number, amount, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [expense_date, category, supplierName, supplierId, invoice_number || null, amt, notes || null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/expense-entries/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureExpenseEntriesTable();
    await dbQuery('DELETE FROM expense_entries WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/all-residents', verifyToken, requireAdmin, async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT id, email, full_name, apartment_number as apartment, phone, is_approved FROM users WHERE user_type = 'resident' ORDER BY apartment_number`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE resident (for admin dashboard - delete approved residents)
app.delete('/api/admin/residents/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if resident exists
    const checkResult = await dbQuery(
      `SELECT id, full_name FROM users WHERE id = ? AND user_type = 'resident'`,
      [id]
    );

    if (checkResult.length === 0) {
      return res.status(404).json({ error: 'דייר לא נמצא' });
    }

    const residentName = checkResult[0].full_name;

    // Keep financial history: refuse if this resident has paid charges
    const paid = await dbQuery(
      `SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND status = 'paid'`,
      [id]
    );
    if (Number(paid[0].n) > 0) {
      return res.status(400).json({ error: 'לדייר יש חיובים ששולמו - לא ניתן למחוק אותו' });
    }

    // Remove the resident's unpaid charges first, then the resident
    await dbQuery(`DELETE FROM payments WHERE user_id = ?`, [id]);
    await dbQuery(`DELETE FROM messages WHERE user_id = ?`, [id]);
    await dbQuery(`DELETE FROM votes_cast WHERE user_id = ?`, [id]);
    await dbQuery(`DELETE FROM maintenance_requests WHERE user_id = ?`, [id]);
    await dbQuery(
      `DELETE FROM users WHERE id = ? AND user_type = 'resident'`,
      [id]
    );

    res.json({ success: true, message: `דייר ${residentName} נמחק בהצלחה` });
  } catch (err) {
    console.error('Delete resident error:', err);
    res.status(500).json({ error: 'שגיאה במחיקת דייר' });
  }
});

// ADMIN - PENDING USERS
app.get('/api/admin/pending-users', verifyToken, requireAdmin, async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT id, email, full_name, apartment_number as apartment, phone FROM users WHERE user_type = 'resident' AND is_approved = 0`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/approve-user/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const userResult = await dbQuery(`SELECT email, full_name FROM users WHERE id = ?`, [req.params.id]);
    await dbQuery(`UPDATE users SET is_approved = 1 WHERE id = ?`, [req.params.id]);
    res.json({ success: true });

    if (userResult.length > 0) {
      const { email, full_name } = userResult[0];
      sendApprovalEmail(email, full_name);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reject-user/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await dbQuery(`DELETE FROM users WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ANNOUNCEMENTS
app.get('/api/announcements', async (req, res) => {
  try {
    await ensureArchiveColumn('announcements');
    const rows = await dbQuery(
      `SELECT a.*, u.full_name FROM announcements a LEFT JOIN users u ON a.admin_id = u.id WHERE NOT (COALESCE(a.archived, 0) = 1 OR a.created_at < ?) ORDER BY a.created_at DESC`,
      [archiveCutoffDate()]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/announcements', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { title, content } = req.body;

    if (isPostgres) {
      const result = await dbQuery(
        `INSERT INTO announcements (admin_id, title, content) VALUES ($1, $2, $3) RETURNING id`,
        [req.user.id, title, content]
      );
      res.json({ success: true, id: result[0].id });
    } else {
      const stmt = db.prepare(
        `INSERT INTO announcements (admin_id, title, content) VALUES (?, ?, ?)`
      );
      const info = stmt.run(req.user.id, title, content);
      res.json({ success: true, id: info.lastID });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/announcements/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await dbQuery(`DELETE FROM announcements WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// VOTES
app.get('/api/votes', verifyToken, async (req, res) => {
  try {
    await ensureArchiveColumn('votes');
    const rows = await dbQuery(`SELECT * FROM votes WHERE NOT (COALESCE(archived, 0) = 1 OR created_at < ?) ORDER BY created_at DESC`, [archiveCutoffDate()]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/votes/:id/options', async (req, res) => {
  try {
    const rows = await dbQuery(`SELECT * FROM vote_options WHERE vote_id = ?`, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/votes', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { question } = req.body;

    if (isPostgres) {
      const result = await dbQuery(
        `INSERT INTO votes (admin_id, title, description, status) VALUES ($1, $2, '', 'open') RETURNING id`,
        [req.user.id, question]
      );
      res.json({ success: true, id: result[0].id });
    } else {
      const stmt = db.prepare(
        `INSERT INTO votes (admin_id, title, status) VALUES (?, ?, 'open')`
      );
      const info = stmt.run(req.user.id, question);
      res.json({ success: true, id: info.lastID });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/votes/:id/options', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { option_text } = req.body;

    if (isPostgres) {
      const result = await dbQuery(
        `INSERT INTO vote_options (vote_id, option_text, vote_count) VALUES ($1, $2, 0) RETURNING id`,
        [req.params.id, option_text]
      );
      res.json({ success: true, id: result[0].id });
    } else {
      const stmt = db.prepare(
        `INSERT INTO vote_options (vote_id, option_text) VALUES (?, ?)`
      );
      const info = stmt.run(req.params.id, option_text);
      res.json({ success: true, id: info.lastID });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/votes/:id/vote', verifyToken, async (req, res) => {
  try {
    const voteId = req.params.id;
    const { option_id } = req.body;

    const existing = await dbQuery(
      `SELECT * FROM votes_cast WHERE vote_id = ? AND user_id = ?`,
      [voteId, req.user.id]
    );

    if (existing.length > 0) return res.status(400).json({ error: 'כבר הצבעת' });

    await dbQuery(`UPDATE vote_options SET vote_count = vote_count + 1 WHERE id = ?`, [option_id]);
    await dbQuery(`INSERT INTO votes_cast (vote_id, user_id) VALUES (?, ?)`, [voteId, req.user.id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/votes/:id/close', verifyToken, requireAdmin, async (req, res) => {
  try {
    await dbQuery(`UPDATE votes SET status = 'closed' WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REPORTS
app.get('/api/admin/reports/summary', verifyToken, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const rows = await dbQuery(
      `SELECT 
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(CASE WHEN status = 'proof_submitted' THEN amount ELSE 0 END), 0) as total_pending,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as total_unpaid,
        COUNT(DISTINCT CASE WHEN status = 'paid' THEN user_id END) as paid_residents
       FROM payments WHERE month = ? AND year = ?`,
      [month, year]
    );

    const countResult = await dbQuery(`SELECT COUNT(*) as cnt FROM users WHERE user_type = 'resident'`);
    const total_residents = parseInt(countResult[0].cnt);
    const row = rows[0];
    const percentage = total_residents > 0 ? Math.round((row.paid_residents / total_residents) * 100) : 0;

    res.json({
      total_paid: row.total_paid,
      total_pending: row.total_pending,
      total_unpaid: row.total_unpaid,
      paid_residents: row.paid_residents,
      total_residents,
      percentage,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PAYMENTS
app.get('/api/payments/my', verifyToken, async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT * FROM payments WHERE user_id = ? ORDER BY year DESC, month DESC`,
      [req.user.id]
    );
    const parsed = rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payments/:id/upload-proof', verifyToken, upload.single('file'), async (req, res) => {
  try {
    const filePath = `/uploads/${req.file.filename}`;
    const notes = req.body.notes || '';
    await dbQuery(
      `UPDATE payments SET proof_file_path = ?, proof_notes = ?, status = 'proof_submitted' WHERE id = ? AND user_id = ?`,
      [filePath, notes, req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/pending-proofs', verifyToken, requireAdmin, async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT p.*, u.full_name, u.apartment_number as apartment FROM payments p 
       JOIN users u ON p.user_id = u.id WHERE p.status = 'proof_submitted' ORDER BY p.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/proofs/:id/approve', verifyToken, requireAdmin, async (req, res) => {
  try {
    await dbQuery(`UPDATE payments SET status = 'paid' WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/proofs/:id/reject', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    await dbQuery(
      `UPDATE payments SET status = 'pending', proof_file_path = NULL, proof_notes = NULL, reject_reason = ? WHERE id = ?`,
      [reason, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REPORTS - EXPENSES / RESIDENTS / YEARLY / EXCEL
const MONTH_NAMES = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

// PostgreSQL returns DECIMAL columns as strings - convert to numbers before adding
function expensesToJson(row) {
  if (!row) return { מעלית: 0, חשמל: 0, ניקיון: 0, גינון: 0, total: 0 };
  const m = Number(row.maintenance_fee) || 0;
  const e = Number(row.electricity) || 0;
  const c = Number(row.cleaning) || 0;
  const g = Number(row.gardening) || 0;
  return { מעלית: m, חשמל: e, ניקיון: c, גינון: g, total: m + e + c + g };
}

app.get('/api/admin/reports/expenses', verifyToken, requireAdmin, async (req, res) => {
  try {
    const rows = await dbQuery(`SELECT * FROM expenses ORDER BY id DESC LIMIT 1`);
    res.json(expensesToJson(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/reports/residents', verifyToken, requireAdmin, async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT u.id, u.full_name, u.apartment_number as apartment,
              COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END), 0) as total_paid,
              COALESCE(SUM(CASE WHEN p.status = 'pending' THEN p.amount ELSE 0 END), 0) as total_unpaid,
              COALESCE(SUM(CASE WHEN p.status = 'proof_submitted' THEN p.amount ELSE 0 END), 0) as total_pending
       FROM users u LEFT JOIN payments p ON p.user_id = u.id WHERE u.user_type = 'resident'
       GROUP BY u.id ORDER BY u.apartment_number`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/reports/yearly', verifyToken, requireAdmin, async (req, res) => {
  try {
    const monthsRows = await dbQuery(`SELECT DISTINCT year, month FROM payments ORDER BY year DESC, month DESC`);
    const countResult = await dbQuery(`SELECT COUNT(*) as cnt FROM users WHERE user_type = 'resident'`);
    const total_residents = parseInt(countResult[0].cnt);

    const results = [];
    for (const my of monthsRows) {
      const payRows = await dbQuery(
        `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as total_paid,
                COUNT(DISTINCT CASE WHEN status = 'paid' THEN user_id END) as paid_residents
         FROM payments WHERE month = ? AND year = ?`,
        [my.month, my.year]
      );
      const row = payRows[0];
      const percentage = total_residents > 0 ? Math.round((row.paid_residents / total_residents) * 100) : 0;
      results.push({
        month: `${MONTH_NAMES[my.month - 1]} ${my.year}`,
        total_paid: row.total_paid,
        paid_residents: row.paid_residents,
        total_residents,
        percentage,
      });
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/reports/excel-export', verifyToken, requireAdmin, async (req, res) => {
  try {
    const residents = await dbQuery(
      `SELECT id, full_name, email, phone, apartment_number as apartment FROM users WHERE user_type = 'resident' ORDER BY apartment_number`
    );
    const payments = await dbQuery(`SELECT * FROM payments`);

    const monthKeysSet = new Set();
    payments.forEach((p) => monthKeysSet.add(`${MONTH_NAMES[p.month - 1]} ${p.year}`));
    const months = Array.from(monthKeysSet).sort();

    const residentsWithPayments = residents.map((resident) => {
      const row = { ...resident };
      months.forEach((m) => { row[m] = 0; });
      payments.filter((p) => p.user_id === resident.id).forEach((p) => {
        const key = `${MONTH_NAMES[p.month - 1]} ${p.year}`;
        row[key] = p.amount;
      });
      return row;
    });

    const expenseRows = await dbQuery(`SELECT * FROM expenses ORDER BY id DESC LIMIT 1`);
    const expenses = expensesToJson(expenseRows[0]);

    res.json({ residents: residentsWithPayments, months, expenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MESSAGES
// Resident -> committee (existing behaviour)
app.post('/api/messages', verifyToken, async (req, res) => {
  try {
    const { subject, content } = req.body;
    if (!subject || !content) return res.status(400).json({ error: 'חסרים שדות חובה' });

    if (isPostgres) {
      const result = await dbQuery(
        `INSERT INTO messages (user_id, sender_type, subject, content, status) 
         VALUES ($1, 'resident', $2, $3, 'unread') RETURNING id`,
        [req.user.id, subject, content]
      );
      sendPushToAdmins('הודעה חדשה מדייר', subject);
      res.json({ success: true, id: result[0].id });
    } else {
      const stmt = db.prepare(
        `INSERT INTO messages (user_id, sender_type, subject, content, status) 
         VALUES (?, 'resident', ?, ?, 'unread')`
      );
      const info = stmt.run(req.user.id, subject, content);
      sendPushToAdmins('הודעה חדשה מדייר', subject);
      res.json({ success: true, id: info.lastInsertRowid });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resident inbox - messages sent to this resident by the committee
app.get('/api/messages', verifyToken, async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT * FROM messages WHERE user_id = ? AND sender_type = 'admin' ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/messages/:id/read', verifyToken, async (req, res) => {
  try {
    await dbQuery(
      `UPDATE messages SET status = 'read' WHERE id = ? AND user_id = ? AND sender_type = 'admin'`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Committee inbox - messages received from residents
app.get('/api/admin/messages', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureArchiveColumn('messages');
    const rows = await dbQuery(
      `SELECT m.*, u.full_name, u.apartment_number as apartment, u.email FROM messages m 
       JOIN users u ON m.user_id = u.id WHERE m.sender_type = 'resident' AND NOT (COALESCE(m.archived, 0) = 1 OR m.created_at < ?) ORDER BY m.created_at DESC`,
      [archiveCutoffDate()]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/messages/:id/read', verifyToken, requireAdmin, async (req, res) => {
  try {
    await dbQuery(`UPDATE messages SET status = 'read' WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Committee -> one specific resident
app.post('/api/admin/messages', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { user_id, subject, content } = req.body;
    if (!user_id || !subject || !content) {
      return res.status(400).json({ error: 'חסרים שדות חובה' });
    }

    const userRows = await dbQuery(
      `SELECT email, full_name FROM users WHERE id = ? AND user_type = 'resident'`,
      [user_id]
    );
    if (userRows.length === 0) return res.status(404).json({ error: 'דייר לא נמצא' });

    if (isPostgres) {
      await dbQuery(
        `INSERT INTO messages (user_id, sender_type, subject, content, status) 
         VALUES ($1, 'admin', $2, $3, 'unread')`,
        [user_id, subject, content]
      );
    } else {
      db.prepare(
        `INSERT INTO messages (user_id, sender_type, subject, content, status) 
         VALUES (?, 'admin', ?, ?, 'unread')`
      ).run(user_id, subject, content);
    }

    res.json({ success: true });

    const { email, full_name } = userRows[0];
    sendMessageEmail(email, full_name, subject, content);
    sendPushToUser(user_id, 'הודעה חדשה מהוועד', subject);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Committee -> all approved residents
app.post('/api/admin/messages/broadcast', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { subject, content } = req.body;
    if (!subject || !content) return res.status(400).json({ error: 'חסרים שדות חובה' });

    const residents = await dbQuery(
      `SELECT id, email, full_name FROM users WHERE user_type = 'resident' AND is_approved = 1`
    );

    for (const r of residents) {
      if (isPostgres) {
        await dbQuery(
          `INSERT INTO messages (user_id, sender_type, subject, content, status) 
           VALUES ($1, 'admin', $2, $3, 'unread')`,
          [r.id, subject, content]
        );
      } else {
        db.prepare(
          `INSERT INTO messages (user_id, sender_type, subject, content, status) 
           VALUES (?, 'admin', ?, ?, 'unread')`
        ).run(r.id, subject, content);
      }
    }

    res.json({ success: true, sent: residents.length });

    residents.forEach((r) => sendMessageEmail(r.email, r.full_name, subject, content));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DEBTORS REPORT
// All dates here are handled as local calendar dates. Date#toISOString would
// convert to UTC and shift the day by one in Israel, so dates are formatted by
// their local parts instead.
function formatDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Parses YYYY-MM-DD (or a Date-parsable string) as a local calendar date.
function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  const d = new Date(value);
  return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Effective due date: the payment's own due_date when set, otherwise the last
// day of the month the payment is for.
function effectiveDueDate(payment) {
  if (payment.due_date) {
    const d = parseLocalDate(payment.due_date);
    if (d) return d;
  }
  // Day 0 of the next month = last day of this month.
  return new Date(payment.year, payment.month, 0);
}

function toNumber(v) {
  // PostgreSQL returns DECIMAL columns as strings.
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

// Who owes money as of a given date (default: today)?
// ---------- PAYMENT ADMIN NOTES (separate from payments.details, which the resident UI reads as JSON) ----------
let paymentNoteColumnReady = false;
async function ensurePaymentNoteColumn() {
  if (paymentNoteColumnReady) return;
  if (isPostgres) {
    await db.query('ALTER TABLE payments ADD COLUMN IF NOT EXISTS admin_note TEXT');
  } else {
    const cols = db.prepare('PRAGMA table_info(payments)').all();
    if (!cols.some((c) => c.name === 'admin_note')) {
      db.exec('ALTER TABLE payments ADD COLUMN admin_note TEXT');
    }
  }
  paymentNoteColumnReady = true;
}

// GET /api/admin/reports/debtors?date=YYYY-MM-DD
app.get('/api/admin/reports/debtors', verifyToken, requireAdmin, async (req, res) => {
  try {
    const cutoff = req.query.date ? parseLocalDate(req.query.date) : new Date();
    if (!cutoff || isNaN(cutoff)) return res.status(400).json({ error: 'תאריך לא תקין' });
    cutoff.setHours(23, 59, 59, 999);

    await ensurePaymentNoteColumn();
    const rows = await dbQuery(
      `SELECT p.id, p.user_id, p.year, p.month, p.amount, p.status, p.due_date, p.admin_note,
              u.full_name, u.apartment_number as apartment, u.phone, u.email
       FROM payments p JOIN users u ON p.user_id = u.id
       WHERE u.user_type = 'resident' AND p.status != 'paid'
       ORDER BY u.apartment_number, p.year, p.month`
    );

    const byResident = new Map();

    for (const row of rows) {
      const due = effectiveDueDate(row);
      if (due > cutoff) continue; // not late yet

      if (!byResident.has(row.user_id)) {
        byResident.set(row.user_id, {
          user_id: row.user_id,
          full_name: row.full_name,
          apartment: row.apartment,
          phone: row.phone,
          email: row.email,
          total_debt: 0,
          months_count: 0,
          oldest_due: null,
          days_late: 0,
          months: [],
          _oldest: null,
        });
      }

      const entry = byResident.get(row.user_id);
      const amount = toNumber(row.amount);
      entry.total_debt += amount;
      entry.months_count += 1;
      entry.months.push({
        id: row.id,
        note: row.admin_note || '',
        year: row.year,
        month: row.month,
        label: `${MONTH_NAMES[row.month - 1]} ${row.year}`,
        amount,
        status: row.status,
        due_date: formatDate(due),
      });

      if (!entry._oldest || due < entry._oldest) {
        entry._oldest = due;
        entry.oldest_due = formatDate(due);
      }
    }

    const debtors = Array.from(byResident.values()).map(({ _oldest, ...d }) => ({
      ...d,
      total_debt: Math.round(d.total_debt * 100) / 100,
      days_late: Math.max(0, Math.floor((cutoff - _oldest) / 86400000)),
    }));

    debtors.sort((a, b) => b.total_debt - a.total_debt);

    res.json({
      as_of: formatDate(cutoff),
      debtors,
      total_debt: Math.round(debtors.reduce((sum, d) => sum + d.total_debt, 0) * 100) / 100,
      debtors_count: debtors.length,
    });
  } catch (err) {
    console.error('Debtors report error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Create the monthly charge for every approved resident who doesn't have one yet.
// POST /api/admin/payments/generate  { year, month, amount, due_date? }
app.post('/api/admin/payments/generate', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { year, month, amount, due_date } = req.body;
    if (!year || !month || !amount) {
      return res.status(400).json({ error: 'חסרים שדות חובה: שנה, חודש וסכום' });
    }
    if (month < 1 || month > 12) {
      return res.status(400).json({ error: 'חודש לא תקין' });
    }

    const residents = await dbQuery(
      `SELECT id FROM users WHERE user_type = 'resident' AND is_approved = 1`
    );

    const existing = await dbQuery(
      `SELECT user_id FROM payments WHERE year = ? AND month = ?`,
      [year, month]
    );
    const alreadyCharged = new Set(existing.map((e) => e.user_id));

    let created = 0;
    for (const r of residents) {
      if (alreadyCharged.has(r.id)) continue;

      if (isPostgres) {
        await dbQuery(
          `INSERT INTO payments (user_id, year, month, amount, status, due_date)
           VALUES ($1, $2, $3, $4, 'pending', $5)`,
          [r.id, year, month, amount, due_date || null]
        );
      } else {
        db.prepare(
          `INSERT INTO payments (user_id, year, month, amount, status, due_date)
           VALUES (?, ?, ?, ?, 'pending', ?)`
        ).run(r.id, year, month, amount, due_date || null);
      }
      created += 1;
    }

    res.json({
      success: true,
      created,
      skipped: residents.length - created,
      message: `נוצרו ${created} חיובים ל${MONTH_NAMES[month - 1]} ${year}`,
    });
  } catch (err) {
    console.error('Generate payments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Initialize and start server
initDatabase();

// ---------- APARTMENT RESIDENTS (building roster, imported from CSV) ----------
// One row per apartment. Kept separate from `users`, because `users` needs a
// unique email and a password, and a roster entry may have neither yet.
let residentsTableReady = false;
async function ensureResidentsTable() {
  if (residentsTableReady) return;
  if (isPostgres) {
    await db.query(`CREATE TABLE IF NOT EXISTS apartment_residents (
      id SERIAL PRIMARY KEY,
      apartment_number TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT,
      phone2 TEXT,
      email TEXT,
      notes TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  } else {
    db.exec(`CREATE TABLE IF NOT EXISTS apartment_residents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      apartment_number TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT,
      phone2 TEXT,
      email TEXT,
      notes TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
  residentsTableReady = true;
}

// Every roster apartment gets a placeholder user so charges, the debtors report and
// messages cover the whole building. A placeholder has no password, so it cannot log in,
// and it is claimed when the resident registers (see /api/register).
function placeholderEmail(apt) {
  return `apt${apt}@roster.local`;
}

async function syncRosterUser(apt, name, phone, email) {
  const registered = await dbQuery(
    `SELECT id FROM users WHERE apartment_number = ? AND password_hash <> ''`, [apt]);
  if (registered.length > 0) return 'registered'; // real account exists: leave it alone

  const placeholder = await dbQuery(
    `SELECT id FROM users WHERE apartment_number = ? AND password_hash = ''`, [apt]);

  let mail = email || placeholderEmail(apt);
  const taken = await dbQuery('SELECT id FROM users WHERE email = ?', [mail]);
  const isOwnRow = placeholder.length > 0 && taken.length > 0 && taken[0].id === placeholder[0].id;
  if (taken.length > 0 && !isOwnRow) mail = placeholderEmail(apt);

  if (placeholder.length > 0) {
    await dbQuery(
      'UPDATE users SET email = ?, full_name = ?, phone = ?, is_approved = 1 WHERE id = ?',
      [mail, name, phone, placeholder[0].id]);
    return 'updated';
  }
  await dbQuery(
    `INSERT INTO users (email, password_hash, full_name, apartment_number, phone, user_type, is_approved)
     VALUES (?, '', ?, ?, ?, 'resident', 1)`,
    [mail, name, apt, phone]);
  return 'created';
}

app.get('/api/admin/apartment-residents', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureResidentsTable();
    const rows = await dbQuery('SELECT * FROM apartment_residents ORDER BY CAST(apartment_number AS INTEGER)', []);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Body: { rows: [{ apartment, full_name, phone, phone2, email, notes }] }
// Upserts by apartment number, so importing the same file twice is safe.
app.post('/api/admin/apartment-residents/import', verifyToken, requireAdmin, async (req, res) => {
  try {
    await ensureResidentsTable();
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (rows.length === 0) return res.status(400).json({ error: 'אין שורות לייבוא' });

    let created = 0, updated = 0, skipped = 0;
    for (const r of rows) {
      const apt = String(r.apartment || '').trim();
      const name = String(r.full_name || '').trim();
      if (!apt || !name) { skipped++; continue; }
      const phone = String(r.phone || '').trim() || null;
      const phone2 = String(r.phone2 || '').trim() || null;
      const email = String(r.email || '').trim() || null;
      const notes = String(r.notes || '').trim() || null;
      await syncRosterUser(apt, name, phone, email);

      const existing = await dbQuery('SELECT id FROM apartment_residents WHERE apartment_number = ?', [apt]);
      if (existing.length > 0) {
        await dbQuery(
          'UPDATE apartment_residents SET full_name = ?, phone = ?, phone2 = ?, email = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE apartment_number = ?',
          [name, phone, phone2, email, notes, apt]
        );
        updated++;
      } else {
        await dbQuery(
          'INSERT INTO apartment_residents (apartment_number, full_name, phone, phone2, email, notes) VALUES (?, ?, ?, ?, ?, ?)',
          [apt, name, phone, phone2, email, notes]
        );
        created++;
      }
    }
    res.json({ success: true, created, updated, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3500;

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

// Admin sets own name, email and password (required once after the first login)
app.put('/api/auth/profile', verifyToken, async (req, res) => {
  try {
    await ensureProfileColumn();
    const { current_password, full_name, email, new_password } = req.body || {};
    const me = await dbQueryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!me || me.user_type !== 'admin') return res.status(403).json({ error: 'Unauthorized' });

    const currentHash = crypto.createHash('sha256').update(String(current_password || '')).digest('hex');
    if (me.password_hash !== currentHash) return res.status(401).json({ error: 'הסיסמה הנוכחית שגויה' });

    const name = String(full_name || '').trim();
    const mail = String(email || '').trim().toLowerCase();
    if (name.length < 2) return res.status(400).json({ error: 'נא להזין שם מלא' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: 'כתובת מייל לא תקינה' });

    const taken = await dbQueryOne('SELECT id FROM users WHERE email = ? AND id <> ?', [mail, me.id]);
    if (taken) return res.status(409).json({ error: 'המייל הזה כבר בשימוש' });

    let hash = me.password_hash;
    if (new_password) {
      if (String(new_password).length < 8) return res.status(400).json({ error: 'הסיסמה החדשה חייבת להיות לפחות 8 תווים' });
      hash = crypto.createHash('sha256').update(String(new_password)).digest('hex');
    }

    await dbQuery(
      'UPDATE users SET full_name = ?, email = ?, password_hash = ?, profile_completed = 1 WHERE id = ?',
      [name, mail, hash, me.id]
    );

    const token = jwt.sign({ id: me.id, email: mail, user_type: me.user_type }, SECRET_KEY, { expiresIn: '7d' });
    res.json({
      token,
      user: { id: me.id, email: mail, full_name: name, apartment: me.apartment_number, user_type: me.user_type, must_update: false },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Web Push: התראות לטלפון (גם כשהאפליקציה סגורה) ----
const webpush = require('web-push');
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:housemitzpe47@gmail.com';
const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.log('ℹ️ VAPID keys not set - push notifications are off');
}

let pushTableReady = false;
async function ensurePushTable() {
  if (pushTableReady) return;
  if (isPostgres) {
    await db.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  } else {
    db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
  pushTableReady = true;
}

async function sendPushToUser(userId, title, body) {
  if (!pushEnabled) return;
  try {
    await ensurePushTable();
    const subs = await dbQuery('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);
    const payload = JSON.stringify({ title, body: String(body || ''), url: '/' });
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      } catch (err) {
        // 404 / 410: the phone removed the permission, so forget this device
        if (err.statusCode === 404 || err.statusCode === 410) {
          await dbQuery('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
        } else {
          console.error('push failed for user', userId, err.statusCode, err.message);
        }
      }
    }
  } catch (err) {
    console.error('sendPushToUser:', err.message);
  }
}

async function sendPushToAdmins(title, body) {
  if (!pushEnabled) return;
  try {
    const admins = await dbQuery(`SELECT id FROM users WHERE user_type = 'admin'`, []);
    for (const a of admins) await sendPushToUser(a.id, title, body);
  } catch (err) {
    console.error('sendPushToAdmins:', err.message);
  }
}

// The app asks for the public key before it subscribes a phone
app.get('/api/push/public-key', (req, res) => {
  res.json({ key: pushEnabled ? VAPID_PUBLIC_KEY : null });
});

// A resident's phone registers for notifications
app.post('/api/push/subscribe', verifyToken, async (req, res) => {
  try {
    await ensurePushTable();
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'מנוי לא תקין' });
    }
    await dbQuery(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      [req.user.id, String(endpoint), String(keys.p256dh), String(keys.auth)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/push/unsubscribe', verifyToken, async (req, res) => {
  try {
    await ensurePushTable();
    await dbQuery('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [req.user.id, String((req.body || {}).endpoint || '')]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Number of messages from the committee that the resident has not read yet
app.get('/api/messages/unread-count', verifyToken, async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND sender_type = 'admin' AND status = 'unread'`,
      [req.user.id]
    );
    res.json({ count: Number(rows[0].c) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
}).on('error', (err) => {
  console.error('❌ Server Error:', err);
  process.exit(1);
});