// Prints a scrypt hash for ADMIN_PASSWORD_HASH. The password itself is never printed.
// Usage:
//   node scripts/hash-password.js "passwordku"   (quick; the password may stay in shell history)
//   node scripts/hash-password.js                (asks for it without showing what you type)
import readline from 'node:readline';
import { hashPassword } from '../src/api/middleware/adminAuth.js';

const MIN_LENGTH = 8;

function readHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) {
      process.stdout.write(prompt);
      rl._writeToOutput = () => {};
    }
    rl.question('', (answer) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

let password = process.argv[2];
if (password === undefined) {
  password = await readHidden('Password admin baru: ');
  if (process.stdin.isTTY && password.length >= MIN_LENGTH) {
    const again = await readHidden('Ulangi password: ');
    if (again !== password) {
      console.error('Password tidak sama.');
      process.exit(1);
    }
  }
}

if (password.length < MIN_LENGTH) {
  console.error(`Password minimal ${MIN_LENGTH} karakter.`);
  process.exit(1);
}

console.log('\nSalin baris di bawah ke Railway → Variables sebagai ADMIN_PASSWORD_HASH:\n');
console.log(await hashPassword(password));
