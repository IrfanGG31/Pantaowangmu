// Fails the build if the Mini App / PWA bundle contains secrets or the dev auth bypass (PRD W7).
// Runs after `vite build`; scans every text file in build/.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'build');
const CHECKS = [
  ['dev auth bypass header', /X-Dev-User-Id/i],
  ['VITE_* variable', /\bVITE_[A-Z0-9_]+/],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['API key (sk-/gsk_)', /\b(?:gsk_|sk-(?:or-)?(?:v1-)?)[A-Za-z0-9]{20,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/]
];
const TEXT = /\.(?:js|mjs|css|html|json|webmanifest|txt|map)$/;

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
if (!fs.existsSync(dir)) {
  console.error(`[check-bundle] ${dir} not found; run vite build first.`);
  process.exit(1);
}

const problems = [];
for (const file of walk(dir).filter((f) => TEXT.test(f))) {
  const text = fs.readFileSync(file, 'utf8');
  for (const [label, re] of CHECKS) if (re.test(text)) problems.push(`${path.relative(dir, file)}: ${label}`);
}
if (problems.length) {
  console.error(`[check-bundle] Bundle not safe to ship:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('[check-bundle] OK: no secrets or dev bypass in the bundle.');
