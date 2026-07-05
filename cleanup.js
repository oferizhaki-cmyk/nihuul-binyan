const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('C:\\Users\\speed\\nihuul_binyan\\nihuul_binyan.db');

console.log('🗑️  Cleaning test data...\n');

// מחק תשלומים
db.run('DELETE FROM payments', (err) => {
  if (err) console.error(err);
  console.log('✅ Deleted all payments');
});

// מחק דיירים (אבל לא את admin)
db.run("DELETE FROM users WHERE user_type = 'resident'", (err) => {
  if (err) console.error(err);
  console.log('✅ Deleted all residents');
});

// שמור רק admin
db.run(`INSERT OR IGNORE INTO users (email, password_hash, full_name, user_type, status)
        VALUES ('admin@test.com', '8d969eef6ecad3c29a3a873fba5fbb1f14fa2f0e4e0a7e3b6a5f1e8b9d4c8', 'Admin Test', 'admin', 'approved')`,
(err) => {
  if (err) console.error(err);
  console.log('✅ Admin user ready\n');
  console.log('════════════════════════');
  console.log('✅ Cleanup Complete!');
  console.log('════════════════════════\n');
  db.close();
});