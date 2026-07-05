const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('nihuul_binyan.db');

const adminHash = crypto.createHash('sha256').update('admin123').digest('hex');
const residentHash = crypto.createHash('sha256').update('123456').digest('hex');

db.run("UPDATE users SET password_hash = ? WHERE email = ?", [adminHash, 'admin@test.com'], (err) => {
  console.log(err ? '❌ ' + err.message : '✅ Admin password set');
});

db.run("UPDATE users SET password_hash = ? WHERE email = ?", [residentHash, 'resident@test.com'], (err) => {
  console.log(err ? '❌ ' + err.message : '✅ Resident password set');
  db.close();
});