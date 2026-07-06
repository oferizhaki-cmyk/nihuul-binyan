const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();

// CORS Configuration
const allowedOrigins = [
  'https://nihuul-frontend.vercel.app',
  'http://localhost:3001',
  'http://localhost:3000',
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

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        apartment_number VARCHAR(50),
        phone VARCHAR(20),
        user_type VARCHAR(50) DEFAULT 'resident',
        is_approved INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS maintenance_requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        title VARCHAR(255),
        description TEXT,
        status VARCHAR(50) DEFAULT 'new',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
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
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER,
        title VARCHAR(255),
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (admin_id) REFERENCES users(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS votes (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER NOT NULL,
        title VARCHAR(255),
        description TEXT,
        status VARCHAR(50) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (admin_id) REFERENCES users(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS vote_options (
        id SERIAL PRIMARY KEY,
        vote_id INTEGER NOT NULL,
        option_text VARCHAR(255),
        vote_count INTEGER DEFAULT 0,
        FOREIGN KEY (vote_id) REFERENCES votes(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS votes_cast (
        id SERIAL PRIMARY KEY,
        vote_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        FOREIGN KEY (vote_id) REFERENCES votes(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        maintenance_fee DECIMAL(10, 2) DEFAULT 0,
        electricity DECIMAL(10, 2) DEFAULT 0,
        cleaning DECIMAL(10, 2) DEFAULT 0,
        gardening DECIMAL(10, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

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
    const result = await pool.query('SELECT * FROM users WHERE email = $1 AND password_hash = $2', [email, hash]);
    const user = result.rows[0];
    
    if (!user) return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
    if (user.user_type === 'resident' && user.is_approved !== 1) {
      return res.status(403).json({ error: 'החשבון שלך ממתין לאישור' });
    }
    
    const token = jwt.sign({ id: user.id, email: user.email, user_type: user.user_type }, SECRET_KEY, { expiresIn: '7d' });
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
    
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'אימייל כבר קיים' });
    
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, apartment_number, phone, user_type, is_approved) 
       VALUES ($1, $2, $3, $4, $5, 'resident', 0) RETURNING id`,
      [email, hash, full_name, apartment, phone || null]
    );
    
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MAINTENANCE
app.get('/api/maintenance', verifyToken, async (req, res) => {
  try {
    let query, params;
    if (req.user.user_type === 'admin') {
      query = `SELECT m.*, u.full_name, u.apartment_number as apartment FROM maintenance_requests m 
               JOIN users u ON m.user_id = u.id ORDER BY m.updated_at DESC`;
      params = [];
    } else {
      query = `SELECT m.*, u.full_name, u.apartment_number as apartment FROM maintenance_requests m 
               JOIN users u ON m.user_id = u.id WHERE m.user_id = $1 ORDER BY m.updated_at DESC`;
      params = [req.user.id];
    }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/maintenance', verifyToken, async (req, res) => {
  try {
    const { description, category } = req.body;
    const title = category || 'בקשת תחזוקה';
    const result = await pool.query(
      `INSERT INTO maintenance_requests (user_id, title, description, status, created_at, updated_at) 
       VALUES ($1, $2, $3, 'new', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
      [req.user.id, title, description]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/maintenance/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query(
      `UPDATE maintenance_requests SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [status, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PAYMENTS
app.get('/api/payments/my', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM payments WHERE user_id = $1 ORDER BY year DESC, month DESC`, [req.user.id]);
    const parsed = result.rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payments/:id/upload-proof', verifyToken, upload.single('file'), async (req, res) => {
  try {
    const filePath = `/uploads/${req.file.filename}`;
    const notes = req.body.notes || '';
    await pool.query(
      `UPDATE payments SET proof_file_path = $1, proof_notes = $2, status = 'proof_submitted' WHERE id = $3 AND user_id = $4`,
      [filePath, notes, req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/pending-proofs', verifyToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, u.full_name, u.apartment_number as apartment FROM payments p 
       JOIN users u ON p.user_id = u.id WHERE p.status = 'proof_submitted' ORDER BY p.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/proofs/:id/approve', verifyToken, requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE payments SET status = 'paid' WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/proofs/:id/reject', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    await pool.query(
      `UPDATE payments SET status = 'pending', proof_file_path = NULL, proof_notes = NULL, reject_reason = $1 WHERE id = $2`,
      [reason, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ANNOUNCEMENTS
app.get('/api/announcements', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, u.full_name FROM announcements a LEFT JOIN users u ON a.admin_id = u.id ORDER BY a.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/announcements', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { title, content } = req.body;
    const result = await pool.query(
      `INSERT INTO announcements (admin_id, title, content) VALUES ($1, $2, $3) RETURNING id`,
      [req.user.id, title, content]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/announcements/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM announcements WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// VOTES
app.get('/api/votes', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM votes ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/votes/:id/options', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM vote_options WHERE vote_id = $1`, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/votes', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { question } = req.body;
    const result = await pool.query(
      `INSERT INTO votes (admin_id, title, description, status) VALUES ($1, $2, '', 'open') RETURNING id`,
      [req.user.id, question]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/votes/:id/options', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { option_text } = req.body;
    const result = await pool.query(
      `INSERT INTO vote_options (vote_id, option_text, vote_count) VALUES ($1, $2, 0) RETURNING id`,
      [req.params.id, option_text]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/votes/:id/vote', verifyToken, async (req, res) => {
  try {
    const voteId = req.params.id;
    const { option_id } = req.body;
    
    const existing = await pool.query(`SELECT * FROM votes_cast WHERE vote_id = $1 AND user_id = $2`, [voteId, req.user.id]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'כבר הצבעת' });
    
    await pool.query(`UPDATE vote_options SET vote_count = vote_count + 1 WHERE id = $1`, [option_id]);
    await pool.query(`INSERT INTO votes_cast (vote_id, user_id) VALUES ($1, $2)`, [voteId, req.user.id]);
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/votes/:id/close', verifyToken, requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE votes SET status = 'closed' WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN
app.get('/api/admin/pending-users', verifyToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, full_name, apartment_number as apartment, phone FROM users WHERE user_type = 'resident' AND is_approved = 0`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/all-residents', verifyToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, full_name, apartment_number as apartment, phone, is_approved FROM users WHERE user_type = 'resident' ORDER BY apartment_number`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/approve-user/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE users SET is_approved = 1 WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reject-user/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
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
    
    const result = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as total_paid,
              COALESCE(SUM(CASE WHEN status = 'proof_submitted' THEN amount ELSE 0 END), 0) as total_pending,
              COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as total_unpaid,
              COUNT(DISTINCT CASE WHEN status = 'paid' THEN user_id END) as paid_residents
       FROM payments WHERE month = $1 AND year = $2`,
      [month, year]
    );
    
    const countResult = await pool.query(`SELECT COUNT(*) as cnt FROM users WHERE user_type = 'resident'`);
    const total_residents = parseInt(countResult.rows[0].cnt);
    const row = result.rows[0];
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

app.get('/api/admin/reports/expenses', verifyToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM expenses ORDER BY id DESC LIMIT 1`);
    if (result.rows.length === 0) {
      return res.json({ שמאל: 0, חשמל: 0, ביקון: 0, גינון: 0, total: 0 });
    }
    const row = result.rows[0];
    const total = row.maintenance_fee + row.electricity + row.cleaning + row.gardening;
    res.json({ שמאל: row.maintenance_fee, חשמל: row.electricity, ביקון: row.cleaning, גינון: row.gardening, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/reports/residents', verifyToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.apartment_number as apartment,
              COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END), 0) as total_paid,
              COALESCE(SUM(CASE WHEN p.status = 'pending' THEN p.amount ELSE 0 END), 0) as total_unpaid,
              COALESCE(SUM(CASE WHEN p.status = 'proof_submitted' THEN p.amount ELSE 0 END), 0) as total_pending
       FROM users u LEFT JOIN payments p ON p.user_id = u.id WHERE u.user_type = 'resident'
       GROUP BY u.id ORDER BY u.apartment_number`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/reports/yearly', verifyToken, requireAdmin, async (req, res) => {
  try {
    const monthsResult = await pool.query(`SELECT DISTINCT year, month FROM payments ORDER BY year DESC, month DESC`);
    const countResult = await pool.query(`SELECT COUNT(*) as cnt FROM users WHERE user_type = 'resident'`);
    const total_residents = parseInt(countResult.rows[0].cnt);
    const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
    
    const results = [];
    for (const my of monthsResult.rows) {
      const payResult = await pool.query(
        `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as total_paid,
                COUNT(DISTINCT CASE WHEN status = 'paid' THEN user_id END) as paid_residents
         FROM payments WHERE month = $1 AND year = $2`,
        [my.month, my.year]
      );
      const row = payResult.rows[0];
      const percentage = total_residents > 0 ? Math.round((row.paid_residents / total_residents) * 100) : 0;
      results.push({
        month: `${monthNames[my.month - 1]} ${my.year}`,
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
    const residentResult = await pool.query(`SELECT id, full_name, email, phone, apartment_number as apartment FROM users WHERE user_type = 'resident' ORDER BY apartment_number`);
    const residents = residentResult.rows;
    
    const paymentResult = await pool.query(`SELECT * FROM payments`);
    const payments = paymentResult.rows;
    
    const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
    const monthKeysSet = new Set();
    payments.forEach((p) => monthKeysSet.add(`${monthNames[p.month - 1]} ${p.year}`));
    const months = Array.from(monthKeysSet).sort();
    
    const residentsWithPayments = residents.map((resident) => {
      const row = { ...resident };
      months.forEach((m) => { row[m] = 0; });
      payments.filter((p) => p.user_id === resident.id).forEach((p) => {
        const key = `${monthNames[p.month - 1]} ${p.year}`;
        row[key] = p.amount;
      });
      return row;
    });
    
    const expenseResult = await pool.query(`SELECT * FROM expenses ORDER BY id DESC LIMIT 1`);
    const expenses = expenseResult.rows.length > 0 ? {
      שמאל: expenseResult.rows[0].maintenance_fee,
      חשמל: expenseResult.rows[0].electricity,
      ביקון: expenseResult.rows[0].cleaning,
      גינון: expenseResult.rows[0].gardening,
      total: expenseResult.rows[0].maintenance_fee + expenseResult.rows[0].electricity + expenseResult.rows[0].cleaning + expenseResult.rows[0].gardening,
    } : { שמאל: 0, חשמל: 0, ביקון: 0, גינון: 0, total: 0 };
    
    res.json({ residents: residentsWithPayments, months, expenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Initialize and start server
initDatabase();

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});