const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('C:\\Users\\speed\\nihuul_binyan\\nihuul_binyan.db');

console.log('👥 All users in database:\n');

db.all('SELECT id, email, full_name, apartment_number, user_type FROM users', (err, rows) => {
  if (err) console.error(err);
  
  rows.forEach(r => {
    console.log(`${r.id}. ${r.full_name} | Apt: ${r.apartment_number} | Email: ${r.email} | Type: ${r.user_type}`);
  });
  
  db.close();
});