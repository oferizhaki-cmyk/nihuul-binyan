const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('C:\\Users\\speed\\nihuul_binyan\\nihuul_binyan.db', (err) => {
  if (err) console.error(err);
  
  console.log('📊 USERS TABLE SCHEMA:\n');
  db.all("PRAGMA table_info(users)", (err, rows) => {
    if (err) console.error(err);
    rows.forEach(row => {
      console.log(`  ${row.name} (${row.type})`);
    });
    
    console.log('\n\n📊 PAYMENTS TABLE SCHEMA:\n');
    db.all("PRAGMA table_info(payments)", (err, rows) => {
      if (err) console.error(err);
      rows.forEach(row => {
        console.log(`  ${row.name} (${row.type})`);
      });
      db.close();
    });
  });
});