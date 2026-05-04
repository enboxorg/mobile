import {
  AGENT_LEVEL_DB_SUBPATHS,
  destroyAgentLevelDatabases,
  destroyRNLevelDatabase,
  normalizeLocation,
  RNLevel,
} from '@/lib/enbox/rn-level';

const mockGetStr = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockClose = jest.fn();

jest.mock('react-native-leveldb', () => {
  const destroyDB = jest.fn();
  function MockLevelDB() {
    return {
      getStr: mockGetStr,
      put: mockPut,
      delete: mockDelete,
      close: mockClose,
    };
  }
  MockLevelDB.destroyDB = destroyDB;
  return { LevelDB: MockLevelDB };
});

const { LevelDB: _MockLevelDB } = jest.requireMock('react-native-leveldb') as {
  LevelDB: { destroyDB: jest.Mock };
};
const mockDestroyDB = _MockLevelDB.destroyDB;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetStr.mockReturnValue('value');
});

describe('normalizeLocation', () => {
  it('flattens nested SDK paths into a single directory name', () => {
    expect(normalizeLocation('DATA/AGENT/VAULT_STORE')).toBe('DATA__AGENT__VAULT_STORE');
  });

  it('strips leading separators and sanitizes unsafe characters', () => {
    expect(normalizeLocation('/DATA/AGENT:SYNC?STORE')).toBe('DATA__AGENT_SYNC_STORE');
  });
});

describe('RNLevel', () => {
  it('opens lazily on first get()', async () => {
    const db = new RNLevel('DATA/AGENT/VAULT_STORE');

    await expect(db.get('foo')).resolves.toBe('value');
    expect(mockGetStr).toHaveBeenCalledWith('foo');
  });

  it('opens lazily on first sublevel() access', async () => {
    const db = new RNLevel('DATA/AGENT/ROOT');
    const sub = db.sublevel('child');

    await expect(sub.put('foo', 'bar')).resolves.toBeUndefined();
    expect(mockPut).toHaveBeenCalledWith('!child!foo', 'bar');
  });

  it('throws a level-style notFound error for missing keys', async () => {
    mockGetStr.mockReturnValueOnce(null);
    const db = new RNLevel('DATA/AGENT/VAULT_STORE');

    await expect(db.get('missing')).rejects.toMatchObject({
      code: 'LEVEL_NOT_FOUND',
      notFound: true,
    });
  });
});

// ===========================================================================
// Round-11 F4 — destroyRNLevelDatabase fail-closed contract
// ===========================================================================
//
// Pre-fix `isIdempotentDestroyError` treated "is not a function" as
// idempotent so test mocks that omitted a `destroyDB` spy still
// resolved cleanly. The same predicate ran in PRODUCTION — and a
// production "LevelDB.destroyDB is not a function" indicates a
// turbomodule registration failure / mislink. Treating that as a
// vacuous success let a release build mark the LevelDB wipe complete
// while every byte of identity / DWN / sync data remained on disk.
// The new contract is fail-CLOSED: missing native method propagates.
describe('destroyRNLevelDatabase — Round-11 F4 fail-closed contract', () => {
  it('resolves successfully when destroyDB completes (vacuous wipe)', async () => {
    mockDestroyDB.mockReturnValueOnce(undefined);
    await expect(destroyRNLevelDatabase('DATA/AGENT/VAULT_STORE')).resolves.toBeUndefined();
    expect(mockDestroyDB).toHaveBeenCalledWith('DATA__AGENT__VAULT_STORE', true);
  });

  it('treats "does not exist" as idempotent (no DB on disk)', async () => {
    mockDestroyDB.mockImplementationOnce(() => {
      throw new Error('IO error: lock /data/.../LOCK: does not exist');
    });
    await expect(destroyRNLevelDatabase('DATA/AGENT/VAULT_STORE')).resolves.toBeUndefined();
  });

  it('treats "no such file" as idempotent (no DB on disk)', async () => {
    mockDestroyDB.mockImplementationOnce(() => {
      throw new Error('open /data/.../LOG: no such file or directory');
    });
    await expect(destroyRNLevelDatabase('DATA/AGENT/VAULT_STORE')).resolves.toBeUndefined();
  });

  it('rethrows "is not a function" — was pre-fix idempotent, now fail-CLOSED to catch turbomodule mislinks', async () => {
    // The exact shape of a "TypeError: x is not a function" from a
    // missing native bridge.
    const err = new TypeError('LevelDB.destroyDB is not a function');
    mockDestroyDB.mockImplementationOnce(() => {
      throw err;
    });
    await expect(destroyRNLevelDatabase('DATA/AGENT/VAULT_STORE')).rejects.toBe(err);
  });

  it('rethrows arbitrary IO / permission failures', async () => {
    const err = new Error('IO error: lock /data/.../LOCK: Permission denied');
    mockDestroyDB.mockImplementationOnce(() => {
      throw err;
    });
    await expect(destroyRNLevelDatabase('DATA/AGENT/VAULT_STORE')).rejects.toBe(err);
  });
});

// ===========================================================================
// Round-13 F2 — destroyAgentLevelDatabases must wipe the root sync DB too
// ===========================================================================
//
// Pre-fix `AGENT_LEVEL_DB_SUBPATHS` included `'SYNC_STORE'` and the
// helper iterated `${dataPath}/${sub}` only. Upstream's
// `SyncEngineLevel({ dataPath })` opens its replication-ledger /
// dead-letter / cursor LevelDB at the LITERAL `dataPath` (root, NOT
// a `${dataPath}/SYNC_STORE` subpath — see
// `node_modules/@enbox/agent/src/sync-engine-level.ts:282`), so the
// pre-fix wipe destroyed a non-existent subpath while every byte of
// sync state survived under the root.
//
// New contract: AGENT_LEVEL_DB_SUBPATHS lists only TRUE child paths;
// `destroyAgentLevelDatabases()` ALSO destroys the root `dataPath`
// after the children. The denominator in the failure-aggregate
// message reflects subpaths + 1 (root).
describe('destroyAgentLevelDatabases — Round-13 F2 sync-at-root wipe', () => {
  it('does not include SYNC_STORE in the subpath list (sync DB lives at root)', () => {
    expect(AGENT_LEVEL_DB_SUBPATHS).not.toContain('SYNC_STORE');
  });

  it('destroys every subpath PLUS the root dataPath itself', async () => {
    mockDestroyDB.mockImplementation(() => undefined);
    await destroyAgentLevelDatabases('ENBOX_AGENT');

    // Every named subpath was destroyed in canonical order, with
    // `force: true` so any open handle is closed first.
    for (const sub of AGENT_LEVEL_DB_SUBPATHS) {
      expect(mockDestroyDB).toHaveBeenCalledWith(
        normalizeLocation(`ENBOX_AGENT/${sub}`),
        true,
      );
    }
    // The ROOT path itself is destroyed too — this is where the
    // SyncEngineLevel ledger / dead-letter / cursors live.
    expect(mockDestroyDB).toHaveBeenCalledWith(
      normalizeLocation('ENBOX_AGENT'),
      true,
    );
    // Total call count = subpaths + 1 (root).
    expect(mockDestroyDB).toHaveBeenCalledTimes(AGENT_LEVEL_DB_SUBPATHS.length + 1);
  });

  it('destroys the root LAST, after every subpath child', async () => {
    const calls: string[] = [];
    mockDestroyDB.mockImplementation((name: string) => {
      calls.push(name);
    });
    await destroyAgentLevelDatabases('ENBOX_AGENT');
    // The very last call MUST target the root — children first
    // ensures `LevelDB.DestroyDB(root)` only sees the sync DB's
    // own flat files (the child subdirectories that LevelDB
    // refuses to recurse into are already gone).
    expect(calls[calls.length - 1]).toBe(normalizeLocation('ENBOX_AGENT'));
    // Sanity: no subpath was destroyed AFTER the root.
    const rootIdx = calls.indexOf(normalizeLocation('ENBOX_AGENT'));
    expect(rootIdx).toBe(calls.length - 1);
  });

  it('reports a root failure with a labelled subpath (`<root sync DB>`) in the aggregate error', async () => {
    // Children succeed, root fails — surface the root-specific
    // failure so on-call can distinguish a sync-DB I/O issue from
    // a child-DB issue.
    const rootErr = new Error(
      'IO error: lock /data/.../LOCK: Permission denied',
    );
    mockDestroyDB.mockImplementation((name: string) => {
      if (name === normalizeLocation('ENBOX_AGENT')) {
        throw rootErr;
      }
    });
    await expect(destroyAgentLevelDatabases('ENBOX_AGENT')).rejects.toThrow(
      /<root sync DB>/,
    );
  });

  it('counts the root attempt in the failure-aggregate denominator', async () => {
    const rootErr = new Error(
      'IO error: lock /data/.../LOCK: Permission denied',
    );
    mockDestroyDB.mockImplementation((name: string) => {
      if (name === normalizeLocation('ENBOX_AGENT')) {
        throw rootErr;
      }
    });
    await expect(destroyAgentLevelDatabases('ENBOX_AGENT')).rejects.toThrow(
      // 1 failure / (subpaths + 1) — the +1 is the root attempt.
      new RegExp(`1/${AGENT_LEVEL_DB_SUBPATHS.length + 1}`),
    );
  });

  it('idempotent on a missing root sync DB (resolves cleanly when nothing on disk)', async () => {
    // First-time reset on a fresh install — no LevelDB files exist
    // yet for the sync engine. The root destroy should fall into
    // the idempotent-not-found branch and the helper returns
    // success, mirroring the same posture for child subpaths.
    mockDestroyDB.mockImplementation((_name: string) => {
      throw new Error('IO error: /data/.../CURRENT: does not exist');
    });
    await expect(destroyAgentLevelDatabases('ENBOX_AGENT')).resolves.toBeUndefined();
  });
});
