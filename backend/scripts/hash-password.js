// Prints a scrypt hash for ADMIN_PASSWORD_HASH. The password is read from the terminal without echo
// (or from stdin when piped) and is never printed.
// Usage: node scripts/hash-password.js
import readline from 'node:readline';
import { hashPassword } from '../src/api/middleware/adminAuth.js';

const MIN_LENGTH = 12;

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

const first = await readHidden('Password admin baru: ');
if (first.length < MIN_LENGTH) {
  console.error(`Password minimal ${MIN_LENGTH} karakter.`);
  process.exit(1);
}
if (process.stdin.isTTY) {
  const second = await readHidden('Ulangi password: ');
  if (second !== first) {
    console.error('Password tidak sama.');
    process.exit(1);
  }
}

console.log('\nSalin baris di bawah ke Railway → Variables sebagai ADMIN_PASSWORD_HASH:\n');
console.log(await hashPassword(first));
