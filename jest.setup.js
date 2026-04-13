// Mock Turbo Native Modules that are resolved at import time.
// These are replaced by real native implementations when the app runs on device.

jest.mock('./specs/NativeSecureStorage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    deleteItem: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('./specs/NativeCrypto', () => ({
  __esModule: true,
  default: {
    sha256: jest.fn((data) => Promise.resolve(`mocksha256_${data}`)),
    pbkdf2: jest.fn((password, salt) => Promise.resolve(`mockpbkdf2_${salt}_${password}`)),
    randomBytes: jest.fn(() => Promise.resolve('0102030405060708090a0b0c0d0e0f10')),
  },
}));
