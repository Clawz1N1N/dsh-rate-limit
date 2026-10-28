/**
 * Minimal static checks for this dependency-free package.
 *
 * "Lint" here means the rules this codebase actually follows: no leftover
 * markers, no over-long lines, and a manifest whose declared entry points
 * exist. Parsing and import resolution are `scripts/typecheck.mjs`; this script
 * stays about shape and hygiene.
 *
 * @module scripts/lint
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['lib', 'client', 'test'];
const MAX_LINE_LENGTH = 160;

/** @type {string[]} */
const failures = [];

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function jsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsFiles(path)));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

/**
 * @param {string} file
 * @param {string} message
 */
function fail(file, message) {
  failures.push(`${relative(ROOT, file)}: ${message}`);
}

for (const dir of SOURCE_DIRS) {
  for (const file of await jsFiles(join(ROOT, dir))) {
    const text = await readFile(file, 'utf8');
    text.split('\n').forEach((line, index) => {
      if (line.length > MAX_LINE_LENGTH) fail(file, `line ${index + 1} is ${line.length} characters`);
      if (/\b(TODO|FIXME|XXX)\b/.test(line)) fail(file, `line ${index + 1} contains a leftover marker`);
    });
    if (/\t/.test(text)) fail(file, 'contains a tab character; this codebase uses two spaces');
  }
}

const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
for (const field of ['name', 'version', 'type', 'main']) {
  if (manifest[field] === undefined) failures.push(`package.json: "${field}" is required`);
}
if (manifest.type !== 'module') failures.push('package.json: "type" must be "module"');
if (manifest.dsh?.client?.platform !== 'web') failures.push('package.json: dsh.client.platform must be "web"');
if (typeof manifest.dsh?.bundle?.patch !== 'string') failures.push('package.json: dsh.bundle.patch is required');

const declared = [
  manifest.main,
  manifest.exports?.['.'],
  manifest.exports?.['./client'],
  manifest.dsh?.bundle?.patch,
  manifest.icon,
];
for (const path of declared) {
  if (typeof path !== 'string') continue;
  const found = await stat(join(ROOT, path)).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!found) failures.push(`package.json: "${path}" does not exist`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error(`lint: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log('lint: clean');
