const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'nihuul_binyan.db');
const db = new sqlite3.Database(dbPath);

function safeRun(sql, label) {
  return new Promise((resolve) => {
    db.run(sql, (err) => {
      if (err) {
        if (err.message.includes('duplicate column') || err.message.includes('already exists')) {
          console.log(`⏭️  ${label} - כבר קיים`);
        } else {
          console.log(`⚠️  ${label} - שגיאה: ${err.message}`);
        }
      } else {
        console.log(`✅ ${label}`);
      }
      resolve();
    });
  });
}

async function migrate() {
  console.log('=== מתחיל Migration לסכמה הקיימת ===\n');

  await safeRun(`ALTER TABLE users ADD COLUMN phone TEXT`, 'הוספת עמודת phone ל-users');
  await safeRun(`ALTER TABLE users ADD COLUMN is_approved INTEGER DEFAULT 1`, 'הוספת עמודת is_approved ל-users');

  await safeRun(`ALTER TABLE payments ADD COLUMN proof_file_path TEXT`, 'הוספת עמודת proof_file_path ל-payments');
  await safeRun(`ALTER TABLE payments ADD COLUMN proof_notes TEXT`, 'הוספת עמודת proof_notes ל-payments');
  await safeRun(`ALTER TABLE payments ADD COLUMN reject_reason TEXT`, 'הוספת עמודת reject_reason ל-payments');
  await safeRun(`ALTER TABLE payments ADD COLUMN details TEXT`, 'הוספת עמודת details ל-payments');

  await safeRun(`
    CREATE TABLE IF NOT EXISTS votes_cast (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vote_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, 'יצירת טבלת votes_cast');

  await safeRun(`
    CREATE TABLE IF NOT EXISTS vote_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vote_id INTEGER NOT NULL,
      option_text TEXT,
      vote_count INTEGER DEFAULT 0
    )
  `, 'יצירת טבלת vote_options');

  await safeRun(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      maintenance_fee REAL DEFAULT 0,
      electricity REAL DEFAULT 0,
      cleaning REAL DEFAULT 0,
      gardening REAL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, 'יצירת טבלת expenses');

  await new Promise((resolve) => {
    db.get('SELECT COUNT(*) as cnt FROM expenses', (err, row) => {
      if (!err && row.cnt === 0) {
        db.run('INSERT INTO expenses (maintenance_fee, electricity, cleaning, gardening) VALUES (0, 0, 0, 0)', () => {
          console.log('✅ נוספה שורת ברירת מחדל לטבלת expenses');
          resolve();
        });
      } else {
        console.log('⏭️  טבלת expenses כבר מכילה נתונים');
        resolve();
      }
    });
  });

  console.log('\n=== Migration הושלם! ===');
  db.close();
}

migrate();