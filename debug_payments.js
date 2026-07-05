const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('C:\\Users\\speed\\nihuul_binyan\\nihuul_binyan.db', (err) => {
  if (err) console.error(err);
  
  console.log('💰 DEBUG - Checking Payments:\n');
  
  db.all(`SELECT user_id, month, amount, status FROM payments ORDER BY user_id, month LIMIT 30`, (err, rows) => {
    if (err) console.error(err);
    
    console.log(`Total payments shown: ${rows.length}\n`);
    
    rows.forEach(r => {
      console.log(`User ${r.user_id}: Month ${r.month}, Amount: ${r.amount}, Status: ${r.status}`);
    });
    
    // ספור סה"כ תשלומים לכל דייר
    db.all(`SELECT user_id, COUNT(*) as count FROM payments GROUP BY user_id`, (err, summary) => {
      console.log('\n📊 Payments per user:');
      summary.forEach(s => {
        console.log(`User ${s.user_id}: ${s.count} payments`);
      });
      db.close();
    });
  });
});