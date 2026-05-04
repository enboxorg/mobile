/**
 * React Native LevelDB adapter compatible with @enbox/* SDK expectations.
 *
 * Wraps `react-native-leveldb` (synchronous JSI) in an async interface
 * matching what the SDK's `createLevelDatabase` factory and `db` params expect.
 *
 * Supports sublevels via key prefixing (same approach as `level`'s sublevel).
 */

import { LevelDB } from 'react-native-leveldb';

const SUBLEVEL_SEP = '!';
const LEVEL_NOT_FOUND = 'LEVEL_NOT_FOUND';

function notFoundError(): Error & { code: string; notFound: true } {
  const err = new Error('Key not found') as Error & { code: string; notFound: true };
  err.code = LEVEL_NOT_FOUND;
  err.notFound = true;
  return err;
}

export interface RNLevelOptions {
  keyEncoding?: string;
  valueEncoding?: string;
}

export function normalizeLocation(location: string): string {
  // react-native-leveldb prepends the app documents/files directory and then
  // opens the provided path directly with LevelDB. Nested relative paths like
  // `DATA/AGENT/VAULT_STORE` fail because parent directories are not created,
  // and LevelDB errors opening the LOCK file.
  //
  // We flatten the logical path into a unique single directory name.
  return location
    .replace(/^[/.]+/, '')
    .replace(/[\\/]+/g, '__')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

export class RNLevel {
  private _db: LevelDB | null = null;
  private _location: string;
  private _prefix: string;
  private _root: RNLevel;
  private _status: 'opening' | 'open' | 'closing' | 'closed' = 'closed';

  /** Used by SDK internals that traverse the sublevel tree. */
  get prefix(): string {
    return this._prefix;
  }

  /** Used by SDK internals that need the root DB. */
  get db(): RNLevel {
    return this._root;
  }

  get status(): string {
    return this._status;
  }

  supports = { additionalMethods: {} };

  constructor(location: string, _options?: RNLevelOptions) {
    this._location = normalizeLocation(location);
    this._prefix = '';
    this._root = this;
  }

  /** Private constructor for sublevels sharing the same native DB. */
  private static createSublevel(
    root: RNLevel,
    nativeDb: LevelDB,
    prefix: string,
  ): RNLevel {
    const sub = Object.create(RNLevel.prototype) as RNLevel;
    sub._db = nativeDb;
    sub._location = root._location;
    sub._prefix = prefix;
    sub._root = root;
    sub._status = 'open';
    sub.supports = { additionalMethods: {} };
    return sub;
  }

  async open(): Promise<void> {
    this.ensureOpen();
  }

  async close(): Promise<void> {
    if (this._status === 'closed') return;
    this._status = 'closing';
    // Only close at the root level
    if (this._root === this && this._db) {
      this._db.close();
      this._db = null;
    }
    this._status = 'closed';
  }

  private prefixedKey(key: string): string {
    return this._prefix + key;
  }

  private ensureOpen(): LevelDB {
    if (!this._db || this._status === 'closed') {
      this._status = 'opening';
      this._db = new LevelDB(this._location, true, false);
      this._status = 'open';
    }

    if (this._status !== 'open') {
      throw new Error('Database is not open');
    }

    return this._db;
  }

  async get(key: string): Promise<string> {
    const db = this.ensureOpen();
    const value = db.getStr(this.prefixedKey(key));
    if (value === null) throw notFoundError();
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    const db = this.ensureOpen();
    db.put(this.prefixedKey(key), value);
  }

  async del(key: string): Promise<void> {
    const db = this.ensureOpen();
    db.delete(this.prefixedKey(key));
  }

  async batch(
    ops: Array<{ type: 'put' | 'del'; key: string; value?: string }>,
  ): Promise<void> {
    const db = this.ensureOpen();
    for (const op of ops) {
      const prefixed = this.prefixedKey(op.key);
      if (op.type === 'put') {
        db.put(prefixed, op.value ?? '');
      } else if (op.type === 'del') {
        db.delete(prefixed);
      }
    }
  }

  async clear(): Promise<void> {
    const db = this.ensureOpen();
    // Delete all keys under this prefix
    const iter = db.newIterator();
    try {
      if (this._prefix) {
        iter.seek(this._prefix);
      } else {
        iter.seekToFirst();
      }
      const keysToDelete: string[] = [];
      while (iter.valid()) {
        const key = iter.keyStr();
        if (this._prefix && !key.startsWith(this._prefix)) break;
        keysToDelete.push(key);
        iter.next();
      }
      for (const key of keysToDelete) {
        db.delete(key);
      }
    } finally {
      iter.close();
    }
  }

  sublevel(
    name: string,
    _options?: RNLevelOptions,
  ): RNLevel {
    const db = this.ensureOpen();
    const prefix = `${this._prefix}${SUBLEVEL_SEP}${name}${SUBLEVEL_SEP}`;
    return RNLevel.createSublevel(this._root, db, prefix);
  }

  async *keys(
    options?: { gt?: string; gte?: string; lt?: string; lte?: string; reverse?: boolean },
  ): AsyncGenerator<string> {
    const db = this.ensureOpen();
    const iter = db.newIterator();
    try {
      const reverse = options?.reverse ?? false;

      if (reverse) {
        if (options?.lte) {
          iter.seek(this.prefixedKey(options.lte));
          // seek goes to >= target, need to back up if past lte
          if (iter.valid() && iter.keyStr() > this.prefixedKey(options.lte)) {
            iter.prev();
          }
        } else if (options?.lt) {
          iter.seek(this.prefixedKey(options.lt));
          if (iter.valid()) iter.prev();
        } else {
          iter.seekLast();
        }
      } else {
        if (options?.gt) {
          iter.seek(this.prefixedKey(options.gt));
          if (iter.valid() && iter.keyStr() === this.prefixedKey(options.gt)) {
            iter.next();
          }
        } else if (options?.gte) {
          iter.seek(this.prefixedKey(options.gte));
        } else if (this._prefix) {
          iter.seek(this._prefix);
        } else {
          iter.seekToFirst();
        }
      }

      while (iter.valid()) {
        const rawKey = iter.keyStr();

        // Stay within prefix bounds
        if (this._prefix && !rawKey.startsWith(this._prefix)) break;

        const key = rawKey.slice(this._prefix.length);

        // Apply range bounds
        if (!reverse) {
          if (options?.lt && key >= options.lt) break;
          if (options?.lte && key > options.lte) break;
        } else {
          if (options?.gt && key <= options.gt) break;
          if (options?.gte && key < options.gte) break;
        }

        yield key;

        if (reverse) {
          iter.prev();
        } else {
          iter.next();
        }
      }
    } finally {
      iter.close();
    }
  }

  async *iterator(
    options?: { gt?: string; gte?: string; lt?: string; lte?: string; reverse?: boolean },
  ): AsyncGenerator<[string, string]> {
    const db = this.ensureOpen();
    const iter = db.newIterator();
    try {
      const reverse = options?.reverse ?? false;

      if (reverse) {
        if (options?.lte) {
          iter.seek(this.prefixedKey(options.lte));
          if (iter.valid() && iter.keyStr() > this.prefixedKey(options.lte)) {
            iter.prev();
          }
        } else {
          iter.seekLast();
        }
      } else {
        if (options?.gt) {
          iter.seek(this.prefixedKey(options.gt));
          if (iter.valid() && iter.keyStr() === this.prefixedKey(options.gt)) {
            iter.next();
          }
        } else if (options?.gte) {
          iter.seek(this.prefixedKey(options.gte));
        } else if (this._prefix) {
          iter.seek(this._prefix);
        } else {
          iter.seekToFirst();
        }
      }

      while (iter.valid()) {
        const rawKey = iter.keyStr();
        if (this._prefix && !rawKey.startsWith(this._prefix)) break;

        const key = rawKey.slice(this._prefix.length);

        if (!reverse) {
          if (options?.lt && key >= options.lt) break;
          if (options?.lte && key > options.lte) break;
        } else {
          if (options?.gt && key <= options.gt) break;
          if (options?.gte && key < options.gte) break;
        }

        yield [key, iter.valueStr()];

        if (reverse) {
          iter.prev();
        } else {
          iter.next();
        }
      }
    } finally {
      iter.close();
    }
  }
}

/**
 * Factory function matching the `createLevelDatabase` signature
 * expected by @enbox/dwn-sdk-js stores.
 */
export async function createRNLevelDatabase(
  location: string,
  options?: RNLevelOptions,
): Promise<RNLevel> {
  const db = new RNLevel(location, options);
  await db.open();
  return db;
}

/**
 * Every LevelDB location the `EnboxUserAgent` opens AS A CHILD of
 * `dataPath`. Used by `destroyAgentLevelDatabases()` to wipe persistent
 * agent state during reset.
 *
 * This mirrors the upstream `@enbox/agent` and `@enbox/dwn-sdk-js`
 * sub-store names. Keep in sync with `node_modules/@enbox/agent/src/
 * enbox-user-agent.ts` / `dwn-api.ts`. The replication-cursor / dead-
 * letter / ledger DB owned by `SyncEngineLevel` is NOT a child path
 * (see `AGENT_LEVEL_DB_ROOT_PATH` below) so it is intentionally
 * absent from this list — round-13 F2.
 */
export const AGENT_LEVEL_DB_SUBPATHS: readonly string[] = [
  'VAULT_STORE',
  'DID_RESOLVERCACHE',
  'DWN_DATASTORE',
  'DWN_STATEINDEX',
  'DWN_MESSAGESTORE',
  'DWN_MESSAGEINDEX',
  'DWN_RESUMABLETASKSTORE',
];

/**
 * Round-13 F2: the `EnboxUserAgent` constructs `SyncEngineLevel` with
 * `new SyncEngineLevel({ dataPath })`, and inside that class the
 * underlying LevelDB is opened DIRECTLY at `dataPath` (NOT at a
 * subpath such as `${dataPath}/SYNC_STORE`):
 *
 *     // node_modules/@enbox/agent/src/sync-engine-level.ts:282
 *     this._db = (db) ? db : new Level(dataPath ?? 'DATA/AGENT/SYNC_STORE');
 *
 * The replication ledger, dead-letter store, and watermark cursors
 * live as sublevels of THAT root DB. So `${dataPath}/SYNC_STORE`
 * does not actually exist on disk — destroying it was a no-op and
 * left every byte of sync ledger / dead-letter / DWN-cursor data
 * resident across reset.
 *
 * `destroyAgentLevelDatabases()` therefore destroys both the
 * subpath children AND the root path (this constant). Order:
 * children first, root last. LevelDB's `DestroyDB` only removes
 * its OWN files (CURRENT, MANIFEST-*, LOCK, *.log, *.ldb) and does
 * NOT recurse into subdirectories, so destroying the root after
 * the children is safe — the child subdirectories are already
 * gone, leaving only the sync DB's flat files at the root for
 * the final destroy to remove.
 *
 * Empty string is the canonical "destroy at the root path itself"
 * marker; the join below special-cases it to skip the trailing
 * slash that would otherwise rename the target to `${dataPath}/`.
 */
export const AGENT_LEVEL_DB_ROOT_PATH = '';

/**
 * Predicate matching error messages emitted by ``LevelDB.destroyDB``
 * for the "database does not exist on disk" idempotent path. This is
 * a legitimate no-op for a reset flow — the caller's intent is "wipe
 * everything", and "nothing to wipe" satisfies that. Anything else
 * (permission denied, I/O error, file-system corruption, missing
 * native bridge) is a HARD failure and MUST surface so the wallet
 * doesn't fall back to a half-clean state.
 *
 * Round-9 F4: hardened from "swallow ALL throw" to "swallow only the
 * known idempotency path". The message patterns are kept lower-cased
 * because react-native-leveldb's underlying LevelDB JNI wrapper
 * embeds the path into the message and the case of "Does not exist"
 * varies across Android API levels.
 *
 * Round-11 F4: REMOVED the "is not a function" pattern. Pre-fix this
 * was added so test mocks that omit a `destroyDB` spy still
 * resolved cleanly, but the same predicate runs in PRODUCTION — and
 * "LevelDB.destroyDB is not a function" in production means the
 * native bridge was not properly linked / a turbomodule registration
 * regressed. Treating that as a vacuous success would let a release
 * build mark the LevelDB wipe complete while every byte of identity /
 * DWN / sync data remained on disk. The right contract is fail-CLOSED:
 * a missing native method is a hard error that surfaces to
 * `useAgentStore.reset()`, which then persists the
 * LEVELDB_CLEANUP_PENDING_KEY sentinel and rethrows so the caller
 * (Settings UI / recovery-restore-screen) can offer a retry. Tests
 * that genuinely need a no-op `destroyDB` must declare it explicitly
 * in their mock.
 */
function isIdempotentDestroyError(err: unknown): boolean {
  const msg = (
    err instanceof Error ? err.message : String(err ?? '')
  ).toLowerCase();
  return (
    msg.includes('does not exist') ||
    msg.includes('not found') ||
    msg.includes('no such file')
  );
}

/**
 * Destroy the on-disk LevelDB at `location`.
 *
 * Uses `react-native-leveldb`'s `LevelDB.destroyDB(name, force)` which
 * closes any open handle first (via the `force` flag) and removes the
 * native database files.
 *
 * Round-9 F4: this used to swallow ALL throws (the catch block was
 * empty). That's the wrong default — a real I/O failure, permission
 * denied, or a corrupt LOCK file would be reported as success, and
 * `useAgentStore.reset()` would then claim the wallet had been wiped
 * even though stale identity / DWN bytes remained on disk. The
 * fix narrows the swallow to KNOWN idempotency paths
 * (`isIdempotentDestroyError`); anything else is rethrown so the
 * caller can persist a retry sentinel and surface failure to the
 * user. Missing-database / native-module-unavailable are still
 * vacuous successes, which is what every existing test relies on.
 */
export async function destroyRNLevelDatabase(location: string): Promise<void> {
  const name = normalizeLocation(location);
  try {
    LevelDB.destroyDB(name, true);
  } catch (err) {
    if (isIdempotentDestroyError(err)) {
      // Idempotent: missing database / unavailable native module
      // is a no-op rather than an error. Reset's intent ("wipe
      // everything") is satisfied by a vacuously-empty wipe.
      return;
    }
    throw err;
  }
}

/**
 * Wipe every LevelDB the `EnboxUserAgent` persists under `dataPath`.
 *
 * This is the fallback that `useAgentStore.reset()` uses to guarantee
 * the app's on-disk state matches a clean post-reset install. Call
 * ordering (close → destroy) is delegated to `destroyRNLevelDatabase`,
 * which passes `force: true` to `LevelDB.destroyDB`.
 *
 * Round-9 F4: previously this looped serially and let one subpath
 * failure abort the rest, which left the wipe in a half-completed
 * state. The new contract is:
 *   1. Attempt every subpath unconditionally — a failure on
 *      `VAULT_STORE` does not block `DWN_DATASTORE` / `DWN_MESSAGESTORE`.
 *   2. Collect any non-idempotent throws.
 *   3. After the loop, rethrow as an AggregateError-style ``Error``
 *      whose `cause` lists every failure. ``useAgentStore.reset()``
 *      uses this to decide whether to persist the
 *      `LEVELDB_CLEANUP_PENDING_KEY` retry sentinel.
 *
 * Round-13 F2: ALSO destroy the root `dataPath` itself — that's
 * where `SyncEngineLevel` opens its replication-ledger /
 * dead-letter / cursor DB (see `AGENT_LEVEL_DB_ROOT_PATH` for the
 * full rationale). Pre-fix the wipe targeted `${dataPath}/SYNC_STORE`
 * which does not exist on disk, leaving every byte of sync state
 * resident across reset. The root destroy is run LAST so the
 * subpath children (which live inside the same parent directory
 * as siblings to the sync DB's own files) are removed first; LevelDB's
 * `DestroyDB` only touches its own flat files, never subdirectories.
 */
export async function destroyAgentLevelDatabases(dataPath: string): Promise<void> {
  const failures: Array<{ subpath: string; error: unknown }> = [];
  for (const sub of AGENT_LEVEL_DB_SUBPATHS) {
    try {
      await destroyRNLevelDatabase(`${dataPath}/${sub}`);
    } catch (err) {
      failures.push({ subpath: sub, error: err });
    }
  }
  // Round-13 F2: destroy the root path itself (sync engine DB).
  // Tracked separately so the failure-list label is unambiguous —
  // a failure here means the SyncEngineLevel state survived, NOT
  // a missing subpath.
  try {
    await destroyRNLevelDatabase(dataPath);
  } catch (err) {
    failures.push({ subpath: '<root sync DB>', error: err });
  }
  if (failures.length === 0) return;
  const subpathList = failures.map((f) => f.subpath).join(', ');
  // The denominator counts subpaths PLUS the root destroy attempt
  // so a partial failure surfaces an honest ratio (e.g. "1/8" when
  // only the root sync DB destroy threw).
  const totalAttempts = AGENT_LEVEL_DB_SUBPATHS.length + 1;
  const aggregate = new Error(
    `destroyAgentLevelDatabases: ${failures.length}/${totalAttempts} ` +
      `subpaths failed to wipe (${subpathList}). The agent's on-disk state may ` +
      `still contain identities / DWN records / sync cursors; useAgentStore.reset() ` +
      `persists a cleanup-pending sentinel so the next launch retries the wipe ` +
      `before opening any LevelDB handle.`,
  );
  // Attach the original failure list so callers / dev-tools can
  // inspect which subpaths failed. ``cause`` is supported on Error
  // since ES2022 and is preserved through ``throw``.
  (aggregate as unknown as { cause?: unknown }).cause = failures;
  throw aggregate;
}
