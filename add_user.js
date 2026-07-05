const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const db = new sqlite3.Database('./nihuul_binyan.db');

async function addUser() {
  const email = 'ofer@test.com';
  const password = '123456';
  const full_name = 'עופר';
  const apartment_number = '5';

  const hashedPassword = await bcrypt.hash(password, 10);

  db.run(
    'INSERT INTO users (email, password_hash, full_name, apartment_number, user_type) VALUES (?, ?, ?, ?, ?)',
    [email, hashedPassword, full_name, apartment_number, 'resident'],
    function(err) {
      if (err) {
        console.error('❌ שגיאה:', err.message);
      } else {
        console.log('✅ משתמש נוסף בהצלחה!');
        console.log('אימייל:', email);
        console.log('סיסמה:', password);
      }
      db.close();
    }
  );
}

addUser();