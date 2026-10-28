/**
 * Static verification without a TypeScript dependency.
 *
 * The plugin intentionally ships no build step, so the checks that matter are
 * the ones a build step would otherwise provide:
 *
 * 1. Every JavaScript file parses as a module.
 * 2. Every relative `import` and every relative `import(...)` type reference
 *    resolves to a file that exists.
 * 3. Every bare import names a module the harness provides at runtime.
 *
 * @module scripts/typecheck
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['lib', 'client', 'test'];
/** Modules present in every installation this plugin can load into. */
const RUNTIME_BARE_IMPORTS = ['node:', '@deepseek-ai/schemastery'];

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

/** Concatenate the three import forms used in this codebase. */
const IMPORT_FROM = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const IMPORT_BARE = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
const IMPORT_TYPE = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/**
 * @param {string} file
 * @returns {Promise<void>}
 */
async function checkFile(file) {
  const text = await readFile(file, 'utf8');
  const name = relative(ROOT, file);

  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) {
    const detail = String(checked.stderr ?? '').trim().split('\n').slice(0, 3).join(' ');
    failures.push(`${name}: does not parse (${detail})`);
    return;
  }

  /** @type {string[]} */
  const specs = [];
  for (const pattern of [IMPORT_FROM, IMPORT_BARE, IMPORT_TYPE]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) specs.push(match[1]);
  }

  for (const specifier of specs) {
    if (!specifier.startsWith('.')) {
      if (!RUNTIME_BARE_IMPORTS.some((prefix) => specifier === prefix || specifier.startsWith(prefix))) {
        failures.push(`${name}: import "${specifier}" is not available at runtime`);
      }
      continue;
    }
    const target = resolve(dirname(file), specifier);
    const found = await stat(target).then(
      (info) => info.isFile(),
      () => false,
    );
    if (!found) failures.push(`${name}: import "${specifier}" does not resolve`);
  }
}

for (const dir of SOURCE_DIRS) {
  for (const file of await jsFiles(join(ROOT, dir))) await checkFile(file);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error(`typecheck: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log('typecheck: clean');
