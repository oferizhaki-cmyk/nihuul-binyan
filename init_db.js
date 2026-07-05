const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'nihuul_binyan.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database error:', err);
    process.exit(1);
  }
  console.log('✅ Database connected');
});

// Check if DB already initialized
db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'", (err, row) => {
  if (row) {
    console.log('✅ Database already initialized');
    db.close();
    process.exit(0);
  }
  
  console.log('🔧 Initializing database...');
  initializeDatabase();
});

function initializeDatabase() {
  db.serialize(() => {
    // Users Table
    db.run(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        apartment_number TEXT NOT NULL,
        phone TEXT,
        user_type TEXT DEFAULT 'resident',
        is_approved INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) console.error('Users table error:', err);
      else console.log('✅ Users table created');
    });

    // Maintenance Requests Table
    db.run(`
      CREATE TABLE maintenance_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT,
        description TEXT,
        status TEXT DEFAULT 'new',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `, (err) => {
      if (err) console.error('Maintenance table error:', err);
      else console.log('✅ Maintenance table created');
    });

    // Payments Table
    db.run(`
      CREATE TABLE payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        year INTEGER,
        month INTEGER,
        amount REAL,
        status TEXT DEFAULT 'pending',
        proof_file_path TEXT,
        proof_notes TEXT,
        reject_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `, (err) => {
      if (err) console.error('Payments table error:', err);
      else console.log('✅ Payments table created');
    });

    // Announcements Table
    db.run(`
      CREATE TABLE announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER,
        title TEXT,
        content TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(admin_id) REFERENCES users(id)
      )
    `, (err) => {
      if (err) console.error('Announcements table error:', err);
      else console.log('✅ Announcements table created');
    });

    // Votes Table
    db.run(`
      CREATE TABLE votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER,
        title TEXT,
        description TEXT,
        status TEXT DEFAULT 'open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(admin_id) REFERENCES users(id)
      )
    `, (err) => {
      if (err) console.error('Votes table error:', err);
      else console.log('✅ Votes table created');
    });

    // Vote Options Table
    db.run(`
      CREATE TABLE vote_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vote_id INTEGER,
        option_text TEXT,
        vote_count INTEGER DEFAULT 0,
        FOREIGN KEY(vote_id) REFERENCES votes(id)
      )
    `, (err) => {
      if (err) console.error('Vote options table error:', err);
      else console.log('✅ Vote options table created');
    });

    // Votes Cast Table
    db.run(`
      CREATE TABLE votes_cast (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vote_id INTEGER,
        user_id INTEGER,
        FOREIGN KEY(vote_id) REFERENCES votes(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `, (err) => {
      if (err) console.error('Votes cast table error:', err);
      else console.log('✅ Votes cast table created');
    });

    // Expenses Table
    db.run(`
      CREATE TABLE expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        maintenance_fee REAL DEFAULT 0,
        electricity REAL DEFAULT 0,
        cleaning REAL DEFAULT 0,
        gardening REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) console.error('Expenses table error:', err);
      else console.log('✅ Expenses table created');
    });

    // Insert Admin User
    const adminHash = crypto.createHash('sha256').update('admin123').digest('hex');
    db.run(
      `INSERT INTO users (email, password_hash, full_name, apartment_number, user_type, is_approved) VALUES (?, ?, ?, ?, 'admin', 1)`,
      ['admin@test.com', adminHash, 'Admin', 'Admin', 'Admin'],
      (err) => {
        if (err) console.error('Admin insert error:', err);
        else console.log('✅ Admin user created (admin@test.com / admin123)');
      }
    );

    // Insert Test Residents
    const residentHash = crypto.createHash('sha256').update('123456').digest('hex');
    for (let i = 1; i <= 3; i++) {
      db.run(
        `INSERT INTO users (email, password_hash, full_name, apartment_number, phone, user_type, is_approved) VALUES (?, ?, ?, ?, ?, 'resident', 1)`,
        [`resident${i}@test.com`, residentHash, `דייר ${i}`, `דירה ${i}`, `050-000-000${i}`, 'resident'],
        (err) => {
          if (!err) console.log(`✅ Resident ${i} created`);
        }
      );
    }

    // Close DB after 2 seconds
    setTimeout(() => {
      db.close(() => {
        console.log('\n✅ Database initialization complete!');
        process.exit(0);
      });
    }, 2000);
  });
}