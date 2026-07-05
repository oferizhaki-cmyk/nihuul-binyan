const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('C:\\Users\\speed\\nihuul_binyan\\nihuul_binyan.db', (err) => {
  if (err) console.error(err);
  
  console.log('🔍 DEBUG - Checking Residents:\n');
  
  db.all(`SELECT id, full_name, apartment_number, email, user_type FROM users ORDER BY id`, (err, rows) => {
    if (err) console.error(err);
    
    console.log(`Total users: ${rows.length}\n`);
    
    rows.forEach(r => {
      console.log(`${r.id}. ${r.full_name} | Apt: ${r.apartment_number} | Email: ${r.email} | Type: ${r.user_type}`);
    });
    
    db.close();
  });
});