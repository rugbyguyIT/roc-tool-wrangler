// Usage: node scripts/hash-password.js 'MyS3curePassword!'
// Prints a bcrypt hash for manual INSERT into profiles.password_hash
const bcrypt = require('bcryptjs');
const pw = process.argv[2];
if (!pw) { console.error("Usage: node scripts/hash-password.js '<password>'"); process.exit(1); }
console.log(bcrypt.hashSync(pw, 10));
