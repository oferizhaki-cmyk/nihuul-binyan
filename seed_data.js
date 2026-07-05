const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./nihuul_binyan.db');

db.serialize(() => {
  console.log('➕ מוסיף תשלומים...');
  const today = new Date().toISOString().split('T')[0];
  
  db.run('INSERT INTO payments (user_id, month, year, amount, status, payment_date) VALUES (1, 1, 2026, 500, "pending", ?)', [today]);
  db.run('INSERT INTO payments (user_id, month, year, amount, status, payment_date) VALUES (1, 2, 2026, 500, "paid", ?)', [today]);
  db.run('INSERT INTO payments (user_id, month, year, amount, status, payment_date) VALUES (1, 3, 2026, 500, "pending", ?)', [today]);

  console.log('➕ מוסיף בקשות תחזוקה...');
  db.run('INSERT INTO maintenance_requests (user_id, title, description, status) VALUES (1, "נוזל קירור AC", "AC לא מקרר בחדר השינה", "open")');
  db.run('INSERT INTO maintenance_requests (user_id, title, description, status) VALUES (1, "תיקון דלת", "דלת הכניסה קצת תקועה", "closed")');

  console.log('➕ מוסיף הודעות...');
  db.run('INSERT INTO announcements (title, content, admin_id) VALUES ("דמי ניהול חודשיים", "דמי הניהול לחודש יוני הם 500 ש״ח", 1)');
  db.run('INSERT INTO announcements (title, content, admin_id) VALUES ("אסיפה כללית", "אסיפה כללית של דיירים ב-30.6 בשעה 19:00", 1)');

  setTimeout(() => {
    console.log('✅ כל הנתונים הוסיפו בהצלחה!');
    db.close();
  }, 500);
});