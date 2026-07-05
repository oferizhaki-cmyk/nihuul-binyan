const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin,X-Requested-With,Content-Type,Accept,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

const SECRET_KEY = 'your-secret-key-change-this';
const dbPath = path.join(__dirname, 'nihuul_binyan.db');
const db = new sqlite3.Database(dbPath);

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

// AUTH
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  db.get('SELECT * FROM users WHERE email = ? AND password_hash = ?', [email, hash], (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
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
  });
});

app.post('/api/register', (req, res) => {
  const { email, password, full_name, apartment, phone } = req.body;
  if (!email || !password || !full_name || !apartment) {
    return res.status(400).json({ error: 'חסרים שדות חובה' });
  }
  db.get('SELECT id FROM users WHERE email = ?', [email], (err, existing) => {
    if (existing) return res.status(400).json({ error: 'אימייל כבר קיים' });
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    db.run(
      `INSERT INTO users (email, password_hash, full_name, apartment_number, phone, user_type, is_approved) VALUES (?, ?, ?, ?, ?, 'resident', 0)`,
      [email, hash, full_name, apartment, phone || null],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
      }
    );
  });
});

// MAINTENANCE
app.get('/api/maintenance', verifyToken, (req, res) => {
  const query = req.user.user_type === 'admin'
    ? `SELECT m.*, u.full_name, u.apartment_number as apartment FROM maintenance_requests m JOIN users u ON m.user_id = u.id ORDER BY m.updated_at DESC`
    : `SELECT m.*, u.full_name, u.apartment_number as apartment FROM maintenance_requests m JOIN users u ON m.user_id = u.id WHERE m.user_id = ? ORDER BY m.updated_at DESC`;
  const params = req.user.user_type === 'admin' ? [] : [req.user.id];
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/maintenance', verifyToken, (req, res) => {
  const { description, category } = req.body;
  const title = category || 'בקשת תחזוקה';
  db.run(
    `INSERT INTO maintenance_requests (user_id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, 'new', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [req.user.id, title, description],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.put('/api/admin/maintenance/:id', verifyToken, requireAdmin, (req, res) => {
  const { status } = req.body;
  db.run(`UPDATE maintenance_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// PAYMENTS
app.get('/api/payments/my', verifyToken, (req, res) => {
  db.all(`SELECT * FROM payments WHERE user_id = ? ORDER BY year DESC, month DESC`, [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const parsed = rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
    res.json(parsed);
  });
});

app.post('/api/payments/:id/upload-proof', verifyToken, upload.single('file'), (req, res) => {
  const filePath = `/uploads/${req.file.filename}`;
  const notes = req.body.notes || '';
  db.run(
    `UPDATE payments SET proof_file_path = ?, proof_notes = ?, status = 'proof_submitted' WHERE id = ? AND user_id = ?`,
    [filePath, notes, req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.get('/api/admin/pending-proofs', verifyToken, requireAdmin, (req, res) => {
  db.all(
    `SELECT p.*, u.full_name, u.apartment_number as apartment FROM payments p JOIN users u ON p.user_id = u.id WHERE p.status = 'proof_submitted' ORDER BY p.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

app.put('/api/admin/proofs/:id/approve', verifyToken, requireAdmin, (req, res) => {
  db.run(`UPDATE payments SET status = 'paid' WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.put('/api/admin/proofs/:id/reject', verifyToken, requireAdmin, (req, res) => {
  const { reason } = req.body;
  db.run(
    `UPDATE payments SET status = 'pending', proof_file_path = NULL, proof_notes = NULL, reject_reason = ? WHERE id = ?`,
    [reason, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// ANNOUNCEMENTS
app.get('/api/announcements', (req, res) => {
  db.all(`SELECT a.*, u.full_name FROM announcements a LEFT JOIN users u ON a.admin_id = u.id ORDER BY a.created_at DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/announcements', verifyToken, requireAdmin, (req, res) => {
  const { title, content } = req.body;
  db.run(`INSERT INTO announcements (admin_id, title, content) VALUES (?, ?, ?)`, [req.user.id, title, content], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

app.delete('/api/announcements/:id', verifyToken, requireAdmin, (req, res) => {
  db.run(`DELETE FROM announcements WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// VOTES
app.get('/api/votes', verifyToken, (req, res) => {
  db.all(`SELECT * FROM votes ORDER BY created_at DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.get('/api/admin/votes', verifyToken, requireAdmin, (req, res) => {
  db.all(`SELECT * FROM votes ORDER BY created_at DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.get('/api/votes/:id/options', (req, res) => {
  db.all(`SELECT * FROM vote_options WHERE vote_id = ?`, [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/votes', verifyToken, requireAdmin, (req, res) => {
  const { question } = req.body;
  db.run(`INSERT INTO votes (admin_id, title, description, status) VALUES (?, ?, ?, 'open')`, [req.user.id, question, ''], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

app.post('/api/votes/:id/options', verifyToken, requireAdmin, (req, res) => {
  const { option_text } = req.body;
  db.run(`INSERT INTO vote_options (vote_id, option_text, vote_count) VALUES (?, ?, 0)`, [req.params.id, option_text], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

app.post('/api/votes/:id/vote', verifyToken, (req, res) => {
  const voteId = req.params.id;
  const { option_id } = req.body;
  db.get(`SELECT * FROM votes_cast WHERE vote_id = ? AND user_id = ?`, [voteId, req.user.id], (err, existing) => {
    if (existing) return res.status(400).json({ error: 'כבר הצבעת' });
    db.run(`UPDATE vote_options SET vote_count = vote_count + 1 WHERE id = ?`, [option_id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.run(`INSERT INTO votes_cast (vote_id, user_id) VALUES (?, ?)`, [voteId, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    });
  });
});

app.put('/api/votes/:id/close', verifyToken, requireAdmin, (req, res) => {
  db.run(`UPDATE votes SET status = 'closed' WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// MESSAGES
app.post('/api/messages', verifyToken, (req, res) => {
  const { subject, content } = req.body;
  db.run(`INSERT INTO announcements (admin_id, title, content) VALUES (?, ?, ?)`, [req.user.id, subject, content], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

app.get('/api/admin/messages', verifyToken, requireAdmin, (req, res) => {
  db.all(
    `SELECT a.*, u.full_name, u.apartment_number as apartment FROM announcements a JOIN users u ON a.admin_id = u.id WHERE a.admin_id IS NOT NULL ORDER BY a.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

app.put('/api/admin/messages/:id/read', verifyToken, requireAdmin, (req, res) => {
  res.json({ success: true });
});

// ADMIN
app.get('/api/admin/pending-users', verifyToken, requireAdmin, (req, res) => {
  db.all(`SELECT id, email, full_name, apartment_number as apartment, phone FROM users WHERE user_type = 'resident' AND is_approved = 0`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.get('/api/admin/all-residents', verifyToken, requireAdmin, (req, res) => {
  db.all(`SELECT id, email, full_name, apartment_number as apartment, phone, is_approved FROM users WHERE user_type = 'resident' ORDER BY apartment_number`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/admin/approve-user/:id', verifyToken, requireAdmin, (req, res) => {
  db.run(`UPDATE users SET is_approved = 1 WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.post('/api/admin/reject-user/:id', verifyToken, requireAdmin, (req, res) => {
  db.run(`DELETE FROM users WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// REPORTS
function getLatestMonthYear(callback) {
  db.get(`SELECT year, month FROM payments ORDER BY year DESC, month DESC LIMIT 1`, (err, row) => {
    if (err || !row) {
      const now = new Date();
      return callback(now.getMonth() + 1, now.getFullYear());
    }
    callback(row.month, row.year);
  });
}

app.get('/api/admin/reports/summary', verifyToken, requireAdmin, (req, res) => {
  getLatestMonthYear((month, year) => {
    db.get(
      `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as total_paid,
              COALESCE(SUM(CASE WHEN status = 'proof_submitted' THEN amount ELSE 0 END), 0) as total_pending,
              COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as total_unpaid,
              COUNT(DISTINCT CASE WHEN status = 'paid' THEN user_id END) as paid_residents
       FROM payments WHERE month = ? AND year = ?`,
      [month, year],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        db.get(`SELECT COUNT(*) as cnt FROM users WHERE user_type = 'resident'`, (err2, countRow) => {
          const total_residents = countRow ? countRow.cnt : 0;
          const percentage = total_residents > 0 ? Math.round((row.paid_residents / total_residents) * 100) : 0;
          res.json({
            total_paid: row.total_paid,
            total_pending: row.total_pending,
            total_unpaid: row.total_unpaid,
            paid_residents: row.paid_residents,
            total_residents,
            percentage,
          });
        });
      }
    );
  });
});

app.get('/api/admin/reports/expenses', verifyToken, requireAdmin, (req, res) => {
  db.get(`SELECT * FROM expenses ORDER BY id DESC LIMIT 1`, (err, row) => {
    if (err || !row) return res.json({ שמאל: 0, חשמל: 0, ביקון: 0, גינון: 0, total: 0 });
    const total = row.maintenance_fee + row.electricity + row.cleaning + row.gardening;
    res.json({ שמאל: row.maintenance_fee, חשמל: row.electricity, ביקון: row.cleaning, גינון: row.gardening, total });
  });
});

app.get('/api/admin/reports/residents', verifyToken, requireAdmin, (req, res) => {
  db.all(
    `SELECT u.id, u.full_name, u.apartment_number as apartment,
            COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END), 0) as total_paid,
            COALESCE(SUM(CASE WHEN p.status = 'pending' THEN p.amount ELSE 0 END), 0) as total_unpaid,
            COALESCE(SUM(CASE WHEN p.status = 'proof_submitted' THEN p.amount ELSE 0 END), 0) as total_pending
     FROM users u LEFT JOIN payments p ON p.user_id = u.id WHERE u.user_type = 'resident'
     GROUP BY u.id ORDER BY u.apartment_number`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

app.get('/api/admin/reports/yearly', verifyToken, requireAdmin, (req, res) => {
  db.all(`SELECT DISTINCT year, month FROM payments ORDER BY year DESC, month DESC`, (err, monthsRows) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get(`SELECT COUNT(*) as cnt FROM users WHERE user_type = 'resident'`, (err2, countRow) => {
      const total_residents = countRow ? countRow.cnt : 0;
      const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
      const results = [];
      let remaining = monthsRows.length;
      if (remaining === 0) return res.json([]);
      monthsRows.forEach((my) => {
        db.get(
          `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as total_paid,
                  COUNT(DISTINCT CASE WHEN status = 'paid' THEN user_id END) as paid_residents
           FROM payments WHERE month = ? AND year = ?`,
          [my.month, my.year],
          (err3, row) => {
            const percentage = total_residents > 0 ? Math.round((row.paid_residents / total_residents) * 100) : 0;
            results.push({
              month: `${monthNames[my.month - 1]} ${my.year}`,
              total_paid: row.total_paid,
              paid_residents: row.paid_residents,
              total_residents,
              percentage,
              _sortYear: my.year,
              _sortMonth: my.month,
            });
            remaining--;
            if (remaining === 0) {
              results.sort((a, b) => (b._sortYear - a._sortYear) || (b._sortMonth - a._sortMonth));
              results.forEach((r) => { delete r._sortYear; delete r._sortMonth; });
              res.json(results);
            }
          }
        );
      });
    });
  });
});

app.get('/api/admin/reports/excel-export', verifyToken, requireAdmin, (req, res) => {
  db.all(`SELECT id, full_name, email, phone, apartment_number as apartment FROM users WHERE user_type = 'resident' ORDER BY apartment_number`, (err, residents) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all(`SELECT * FROM payments`, (err2, payments) => {
      if (err2) return res.status(500).json({ error: err2.message });
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
      db.get(`SELECT * FROM expenses ORDER BY id DESC LIMIT 1`, (err3, expRow) => {
        const expenses = expRow ? {
          שמאל: expRow.maintenance_fee,
          חשמל: expRow.electricity,
          ביקון: expRow.cleaning,
          גינון: expRow.gardening,
          total: expRow.maintenance_fee + expRow.electricity + expRow.cleaning + expRow.gardening,
        } : { שמאל: 0, חשמל: 0, ביקון: 0, גינון: 0, total: 0 };
        res.json({ residents: residentsWithPayments, months, expenses });
      });
    });
  });
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});