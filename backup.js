const fs = require('fs');
const path = require('path');

const sourceDb = path.join(__dirname, 'nihuul_binyan.db');
const backupDir = path.join(__dirname, 'backups');

// יצור תיקיית backups אם לא קיימת
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
  console.log(`✅ Created backups directory: ${backupDir}`);
}

// יצור backup עם timestamp
const now = new Date();
const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
const backupFile = path.join(backupDir, `backup_${timestamp}.db`);

try {
  fs.copyFileSync(sourceDb, backupFile);
  console.log(`✅ Backup created successfully: ${backupFile}`);
} catch (err) {
  console.error(`❌ Backup failed: ${err.message}`);
  process.exit(1);
}

// שמור רק את 7 הגיבויים האחרונים
const files = fs.readdirSync(backupDir)
  .filter(f => f.startsWith('backup_') && f.endsWith('.db'))
  .sort()
  .reverse();

if (files.length > 7) {
  files.slice(7).forEach(file => {
    const oldFile = path.join(backupDir, file);
    fs.unlinkSync(oldFile);
    console.log(`🗑️  Deleted old backup: ${file}`);
  });
}

console.log(`📊 Current backups: ${Math.min(files.length, 7)}`);