const XLSX = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const dbPath = 'C:\\Users\\speed\\nihuul_binyan\\nihuul_binyan.db';
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
  console.log('✅ Connected to database\n');
  startImport();
});

function startImport() {
  const excelPath = 'C:\\Users\\speed\\OneDrive\\עופר יצחקי\\ועד בית מצפה שוהם\\עותק של עותק של דוח הוצאות הכנסות ועד בית  המצפה 47 שוהם2021.xlsm';
  
  let workbook, worksheet;
  try {
    workbook = XLSX.readFile(excelPath);
    worksheet = workbook.Sheets['תזרים מזומנים  2026'];
    console.log('✅ Excel file loaded\n');
  } catch (err) {
    console.error('❌ Error reading Excel:', err);
    db.close();
    return;
  }

  const months = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const residents = [];

  for (let row = 6; row <= 23; row++) {
    const nameCell = worksheet[`B${row}`];
    const phoneCell = worksheet[`C${row}`];
    const emailCell = worksheet[`D${row}`];
    
    if (!nameCell || !nameCell.v) continue;
    
    const name = String(nameCell.v).trim();
    if (!name.includes('דירה')) continue;

    const phone = phoneCell ? String(phoneCell.v).trim() : null;
    let email = emailCell ? String(emailCell.v).trim() : null;
    
    if (email && email.includes('\\')) email = email.split('\\')[0].trim();
    if (email === 'laura' || email === '' || !email) email = null;

    const payments = {};
    for (let monthIdx = 0; monthIdx < months.length; monthIdx++) {
      const colLetter = String.fromCharCode(69 + monthIdx);
      const cell = worksheet[`${colLetter}${row}`];
      let value = cell ? cell.v : null;
      
      if (value === 'שולם ' || value === 'שולם' || value === 'שולם חלקי ') {
        payments[months[monthIdx]] = 'paid';
      } else if (value === 'XXX' || value === null) {
        payments[months[monthIdx]] = null;
      } else if (typeof value === 'number') {
        payments[months[monthIdx]] = value;
      }
    }

    residents.push({ name, phone, email, payments });
  }

  console.log(`📊 Found ${residents.length} residents\n`);

  // מחק תשלומים ישנים כדי להתחיל מחדש
  db.run('DELETE FROM payments', (err) => {
    if (err) console.error('Warning:', err);
    
    let processedCount = 0;

    residents.forEach((resident, idx) => {
      const apartmentNum = resident.name.match(/דירה\s+(\d+)/)?.[1];
      const emailToUse = resident.email || `apt${apartmentNum}@building.local`;

      // בדוק אם קיים כבר
      db.get('SELECT id FROM users WHERE apartment_number = ?', [parseInt(apartmentNum)], (err, existingUser) => {
        if (err) {
          console.error(`❌ ${idx + 1}. ${resident.name} - Error:`, err.message);
          processedCount++;
          if (processedCount === residents.length) finish();
          return;
        }

        let userId;

        if (existingUser) {
          userId = existingUser.id;
          console.log(`⏭️  ${idx + 1}. ${resident.name} - קיים כבר (ID: ${userId})`);
          processedCount++;
          addPayments(userId, resident, idx);
          if (processedCount === residents.length) finish();
        } else {
          // צור משתמש חדש
          const hash = crypto.createHash('sha256').update('password123').digest('hex');

          db.run(
            `INSERT INTO users (email, password_hash, full_name, apartment_number, user_type, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`,
            [
              emailToUse,
              hash,
              resident.name,
              apartmentNum,
              'resident'
            ],
            function(insertErr) {
              if (insertErr) {
                console.error(`❌ ${idx + 1}. ${resident.name} - Insert error:`, insertErr.message);
                processedCount++;
                if (processedCount === residents.length) finish();
                return;
              }

              userId = this.lastID;
              console.log(`✅ ${idx + 1}. ${resident.name} (דירה ${apartmentNum}) - ID ${userId}`);

              processedCount++;
              addPayments(userId, resident, idx);
              if (processedCount === residents.length) finish();
            }
          );
        }
      });

      function addPayments(userId, resident, idx) {
        let paymentCount = 0;
        Object.entries(resident.payments).forEach(([month, value]) => {
          if (value !== null) {
            const monthNum = months.indexOf(month) + 1;
            const amount = value === 'paid' ? 0 : value;
            const status = value === 'paid' ? 'paid' : 'pending';
            const paymentDate = status === 'paid' ? new Date().toISOString().split('T')[0] : null;

            db.run(
              `INSERT OR IGNORE INTO payments (user_id, amount, status, month, year, payment_date, created_at)
               VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
              [userId, amount, status, monthNum, 2026, paymentDate],
              (payErr) => {
                if (!payErr) paymentCount++;
              }
            );
          }
        });

        console.log(`   └─ תשלומים: ${paymentCount} חודשים`);
      }
    });

    function finish() {
      setTimeout(() => {
        console.log(`\n════════════════════════`);
        console.log(`✅ Import Complete!`);
        console.log(`════════════════════════\n`);
        db.close();
      }, 1500);
    }
  });
}