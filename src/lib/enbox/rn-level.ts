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
