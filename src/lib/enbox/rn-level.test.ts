import { destroyRNLevelDatabase, RNLevel, normalizeLocation } from '@/lib/enbox/rn-level';

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
