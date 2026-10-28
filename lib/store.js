/**
 * Persistence for rolling-window counters.
 *
 * The file is versioned and written atomically (render into a sibling temp file,
 * then rename), so a crash or a concurrent reader never observes a half-written
 * state. Rows older than the longest window are dropped on load, and a damaged
 * file degrades to "no counters" instead of failing plugin activation.
 *
 * @module dsh-llm-model-rate-limit/lib/store
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { STATE_VERSION } from './constants.js';

/** Windows on some filesystems report a transient sharing violation. */
const RENAME_RETRY_DELAYS_MS = [5, 15, 40, 100];

/**
 * @typedef {object} PersistedState
 * @property {number} version
 * @property {number} savedWall - wall time when the file was written.
 * @property {{ mono: number, wall: number }} anchor - this process's clock anchor.
 * @property {Record<string, Array<[number, number, number]>>} models
 */

/**
 * Read and migrate a state file.
 *
 * @param {string} path - absolute state file path.
 * @param {number} currentVersion - schema version this build writes.
 * @returns {Promise<{ state: PersistedState | undefined, reason?: string }>}
 */
export async function loadState(path, currentVersion = STATE_VERSION) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT') return { state: undefined };
    return { state: undefined, reason: `state file is unreadable (${String(code ?? error)})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: undefined, reason: 'state file is not valid JSON' };
  }
  const migrated = migrate(parsed, currentVersion);
  if (migrated.reason !== undefined) return { state: undefined, reason: migrated.reason };
  return { state: /** @type {PersistedState} */ (migrated.state) };
}

/**
 * Bring an older document forward, or refuse a document this build cannot read.
 *
 * Version 1 is the first schema, so there is nothing to rewrite yet; the step
 * table exists so a later version adds one entry instead of growing a chain of
 * ad-hoc checks.
 *
 * @param {unknown} raw
 * @param {number} currentVersion
 * @returns {{ state?: PersistedState, reason?: string }}
 */
export function migrate(raw, currentVersion) {
  if (typeof raw !== 'object' || raw === null) return { reason: 'state file has no document' };
  const document = /** @type {Record<string, unknown>} */ (raw);
  let version = typeof document.version === 'number' && Number.isInteger(document.version) ? document.version : 0;
  if (version > currentVersion) {
    return { reason: `state file was written by a newer plugin version (schema ${version})` };
  }
  /** @type {Record<string, unknown>} */
  let working = document;
  if (version < 1) {
    // Schema 0: an unversioned map of model keys to bucket rows.
    const models = typeof document.models === 'object' && document.models !== null ? document.models : {};
    working = { version: 1, savedWall: Number(document.savedWall ?? 0), anchor: document.anchor, models };
    version = 1;
  }
  const anchor = working.anchor;
  if (typeof anchor !== 'object' || anchor === null) return { reason: 'state file has no clock anchor' };
  const { mono, wall } = /** @type {{ mono?: unknown, wall?: unknown }} */ (anchor);
  if (typeof mono !== 'number' || !Number.isFinite(mono)) return { reason: 'state file anchor has no monotonic reading' };
  if (typeof wall !== 'number' || !Number.isFinite(wall)) return { reason: 'state file anchor has no wall reading' };
  const models = working.models;
  if (typeof models !== 'object' || models === null) return { reason: 'state file has no model counters' };
  return {
    state: {
      version: currentVersion,
      savedWall: typeof working.savedWall === 'number' && Number.isFinite(working.savedWall) ? working.savedWall : wall,
      anchor: { mono, wall },
      models: /** @type {Record<string, Array<[number, number, number]>>} */ (models),
    },
  };
}

/**
 * Replace the state file atomically.
 *
 * @param {string} path
 * @param {PersistedState} state
 * @returns {Promise<void>}
 */
export async function saveState(path, state) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomBytes(6).toString('hex')}.state.tmp`);
  const text = `${JSON.stringify(state)}\n`;
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  try {
    await renameWithRetry(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * Resolve the plugin's per-profile state directory.
 *
 * `DSH_PROFILE_DIR` is set in every shell call of a profile-launched Harness, so
 * the counters land beside the profile they belong to. Without a profile the
 * path falls back to the harness home supplied by the caller.
 *
 * @param {{ profileDir?: string, home: string }} options
 * @returns {string}
 */
export function resolveStateDir(options) {
  const base = options.profileDir ?? join(options.home, 'profiles', 'default');
  return join(base, '.dsh', 'model-rate-limit');
}

/**
 * @param {string} dir
 * @returns {string}
 */
export function statePathIn(dir) {
  return join(dir, 'state.json');
}
