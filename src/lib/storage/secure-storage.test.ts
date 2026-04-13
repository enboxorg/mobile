import NativeSecureStorage from '@specs/NativeSecureStorage';

import { deleteSecureItem, getSecureItem, setSecureItem } from '@/lib/storage/secure-storage';

jest.mock('@specs/NativeSecureStorage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    deleteItem: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('secure storage wrapper', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates getItem to the native module', async () => {
    await getSecureItem('session');
    expect(NativeSecureStorage.getItem).toHaveBeenCalledWith('session');
  });

  it('delegates setItem to the native module', async () => {
    await setSecureItem('session', 'value');
    expect(NativeSecureStorage.setItem).toHaveBeenCalledWith('session', 'value');
  });

  it('delegates deleteItem to the native module', async () => {
    await deleteSecureItem('session');
    expect(NativeSecureStorage.deleteItem).toHaveBeenCalledWith('session');
  });
});
