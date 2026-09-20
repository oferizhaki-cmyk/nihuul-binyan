const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
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

// Email (Nodemailer) Configuration
const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendApprovalEmail(toEmail, fullName) {
  try {
    await mailTransporter.sendMail({
      from: `"ועד בית מצפה 47" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: 'הבקשה שלך אושרה',
      html: `
        <div dir="rtl" style="font-family: Arial, sans-serif;">
          <h2>שלום ${fullName},</h2>
          <p>הבקשה שלך להצטרפות למערכת ניהול הבניין אושרה על ידי ראש הוועד.</p>
          <p>כעת תוכל/י להתחבר למערכת עם כתובת המייל והסיסמה שנרשמו בהרשמה.</p>
        </div>
      `,
    });
    console.log('✅ Approval email sent to', toEmail);
  } catch (err) {
    console.error('❌ Failed to send approval email:', err.message);
  }
}

// Helper function for database queries (works for both SQLite and PostgreSQL)
async function dbQuery(query, params = []) {
  if (isPostgres) {
    const result = await db.query(query, params);
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
    const result = await db.query(query, params);
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

    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

// AUTH
app.post('/api/auth/login', async (req, res) => {
  try {
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

    const existing = await dbQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) return res.status(400).json({ error: 'אימייל כבר קיים' });

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
app.get('/api/maintenance', verifyToken, async (req, res) => {
  try {
    let rows;
    if (req.user.user_type === 'admin') {
      rows = await dbQuery(
        `SELECT m.*, u.full_name, u.apartment_number as apartment FROM maintenance_requests m 
         JOIN users u ON m.user_id = u.id ORDER BY m.updated_at DESC`
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

    // Delete the resident
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
    const rows = await dbQuery(
      `SELECT a.*, u.full_name FROM announcements a LEFT JOIN users u ON a.admin_id = u.id ORDER BY a.created_at DESC`
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
    const rows = await dbQuery(`SELECT * FROM votes ORDER BY created_at DESC`);
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

// Initialize and start server
initDatabase();

const PORT = process.env.PORT || 3500;

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
}).on('error', (err) => {
  console.error('❌ Server Error:', err);
  process.exit(1);
});