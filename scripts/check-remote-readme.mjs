import { execSync } from 'node:child_process';

const raw = execSync('gh api repos/Clawz1N1N/dsh-rate-limit/contents/README.md --jq .content', { encoding: 'utf8' }).trim();
const text = Buffer.from(raw, 'base64').toString('utf8');
const refs = text.match(/assets[^\n)'\"]*/g) || [];
console.log('--- remote README asset refs ---');
refs.forEach((s) => console.log(JSON.stringify(s)));
console.log('--- remote README line count ---', text.split('\n').length);
console.log('--- has markdown image syntax ---', /!\[/.test(text));
console.log('--- remote README head ---');
console.log(text.split('\n').slice(0, 14).join('\n'));