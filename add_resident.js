const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const db = new sqlite3.Database('C:\\Users\\speed\\nihuul_binyan\\nihuul_binyan.db');

const resident = {
  email: 'resident@test.com',
  password: 'resident123',
  name: 'דייר טסט - דירה 1',
  apartment: 1
};

const hash = crypto.createHash('sha256').update(resident.password).digest('hex');

db.run(
  `INSERT INTO users (email, password_hash, full_name, apartment_number, user_type)
   VALUES (?, ?, ?, ?, ?)`,
  [resident.email, hash, resident.name, resident.apartment, 'resident'],
  function(err) {
    if (err) {
      console.error('❌ Error:', err);
    } else {
      console.log(`\n✅ Resident created!\n`);
      console.log(`📧 Email: ${resident.email}`);
      console.log(`🔑 Password: ${resident.password}`);
      console.log(`🏠 Apartment: ${resident.apartment}\n`);
    }
    db.close();
  }
);