const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'nihuul_binyan.db');
const db = new sqlite3.Database(dbPath);

db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
  if (err) {
    console.error('Error:', err);
    return;
  }

  console.log('=== TABLES FOUND ===');
  console.log(tables.map(t => t.name).join(', '));
  console.log('');

  let remaining = tables.length;

  tables.forEach((table) => {
    db.all(`PRAGMA table_info(${table.name})`, (err, columns) => {
      console.log(`=== TABLE: ${table.name} ===`);
      columns.forEach(col => {
        console.log(`  ${col.name} (${col.type})`);
      });
      console.log('');

      remaining--;
      if (remaining === 0) {
        db.close();
      }
    });
  });
});