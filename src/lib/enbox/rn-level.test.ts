import { RNLevel, normalizeLocation } from '@/lib/enbox/rn-level';

const mockGetStr = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockClose = jest.fn();

jest.mock('react-native-leveldb', () => ({
  LevelDB: jest.fn().mockImplementation(() => ({
    getStr: mockGetStr,
    put: mockPut,
    delete: mockDelete,
    close: mockClose,
  })),
}));

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
