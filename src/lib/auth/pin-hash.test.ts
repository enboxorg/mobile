import NativeCrypto from '@specs/NativeCrypto';

import { hashPin, verifyPin } from '@/lib/auth/pin-hash';

jest.mock('@specs/NativeCrypto', () => ({
  __esModule: true,
  default: {
    randomBytes: jest.fn().mockResolvedValue('0102030405060708090a0b0c0d0e0f10'),
    pbkdf2: jest.fn((password: string, salt: string) =>
      Promise.resolve(`derived_${salt}_${password}`),
    ),
    sha256: jest.fn(),
  },
}));

describe('pin-hash', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('hashPin', () => {
    it('returns a salt:derivedKey string', async () => {
      const result = await hashPin('1234');

      expect(result).toMatch(/^[0-9a-f]+:.+$/);
      expect(NativeCrypto.randomBytes).toHaveBeenCalledWith(16);
      expect(NativeCrypto.pbkdf2).toHaveBeenCalledWith(
        '1234',
        expect.any(String),
        100_000,
        32,
      );
    });
  });

  describe('verifyPin', () => {
    it('returns true for a matching PIN', async () => {
      const stored = await hashPin('5678');
      const result = await verifyPin('5678', stored);
      expect(result).toBe(true);
    });

    it('returns false for a wrong PIN', async () => {
      const stored = await hashPin('5678');
      const result = await verifyPin('0000', stored);
      expect(result).toBe(false);
    });

    it('returns false for malformed stored value', async () => {
      const result = await verifyPin('1234', 'no-separator');
      expect(result).toBe(false);
    });
  });
});
