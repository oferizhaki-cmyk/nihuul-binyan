const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('C:\\Users\\speed\\nihuul_binyan\\nihuul_binyan.db', (err) => {
  if (err) console.error(err);
  
  console.log('🔍 VERIFICATION:\n');
  
  // ספור דיירים
  db.get('SELECT COUNT(*) as count FROM users WHERE user_type = "resident"', (err, row) => {
    console.log(`👥 Total Residents: ${row.count}`);
  });
  
  // ספור תשלומים
  db.get('SELECT COUNT(*) as count FROM payments', (err, row) => {
    console.log(`💰 Total Payments: ${row.count}`);
  });
  
  // הראה דיירים
  console.log('\n📋 Sample Residents:\n');
  db.all('SELECT id, full_name, apartment_number, email FROM users WHERE user_type = "resident" LIMIT 5', (err, rows) => {
    rows.forEach(r => {
      console.log(`${r.id}. ${r.full_name} - Apt ${r.apartment_number} (${r.email})`);
    });
    
    // הראה תשלומים
    console.log('\n💳 Sample Payments:\n');
    db.all(`SELECT p.id, u.full_name, p.amount, p.status, p.month, p.year 
            FROM payments p 
            JOIN users u ON p.user_id = u.id 
            LIMIT 10`, (err, rows) => {
      rows.forEach(r => {
        console.log(`User ${r.full_name}: ${r.amount}₪ (${r.status}) - Month ${r.month}/${r.year}`);
      });
      db.close();
    });
  });
});