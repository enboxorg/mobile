import NativeSecureStorage from '@specs/NativeSecureStorage';

export async function getSecureItem(key: string): Promise<string | null> {
  return NativeSecureStorage.getItem(key);
}

export async function setSecureItem(key: string, value: string): Promise<void> {
  return NativeSecureStorage.setItem(key, value);
}

export async function deleteSecureItem(key: string): Promise<void> {
  return NativeSecureStorage.deleteItem(key);
}
