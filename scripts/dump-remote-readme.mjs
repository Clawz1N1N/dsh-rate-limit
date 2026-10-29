import { execSync } from 'node:child_process';
const raw = execSync('gh api repos/Clawz1N1N/dsh-rate-limit/contents/README.md --jq .content', { encoding: 'utf8' }).trim();
const text = Buffer.from(raw, 'base64').toString('utf8');
console.log('=== REMOTE README.md (' + text.split('\n').length + ' lines) ===');
text.split('\n').forEach((l, i) => console.log(`${String(i + 1).padStart(3)}: ${l}`));