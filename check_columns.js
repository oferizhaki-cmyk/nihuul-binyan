const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('C:\\Users\\speed\\nihuul_binyan\\nihuul_binyan.db');

console.log('🔍 Checking users table columns:\n');

db.all("PRAGMA table_info(users)", (err, rows) => {
  if (err) console.error(err);
  
  rows.forEach(r => {
    console.log(`${r.name} (${r.type})`);
  });
  
  db.close();
});