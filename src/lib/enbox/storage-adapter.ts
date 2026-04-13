/**
 * StorageAdapter for @enbox/auth backed by our NativeSecureStorage Turbo Module.
 *
 * Implements the StorageAdapter interface:
 *   get(key): Promise<string | null>
 *   set(key, value): Promise<void>
 *   remove(key): Promise<void>
 *   clear(): Promise<void>
 */

import NativeSecureStorage from '@specs/NativeSecureStorage';

const PREFIX = 'enbox:';
const KEY_INDEX = `${PREFIX}__keys__`;

export class SecureStorageAdapter {
  async get(key: string): Promise<string | null> {
    return NativeSecureStorage.getItem(PREFIX + key);
  }

  async set(key: string, value: string): Promise<void> {
    const prefixedKey = PREFIX + key;
    await NativeSecureStorage.setItem(prefixedKey, value);
    await this.trackKey(prefixedKey);
  }

  async remove(key: string): Promise<void> {
    const prefixedKey = PREFIX + key;
    await NativeSecureStorage.deleteItem(prefixedKey);
    await this.untrackKey(prefixedKey);
  }

  async clear(): Promise<void> {
    const keys = await this.getTrackedKeys();
    await Promise.all(keys.map((k) => NativeSecureStorage.deleteItem(k)));
    await NativeSecureStorage.deleteItem(KEY_INDEX);
  }

  // --- Key tracking (Keychain has no enumeration API) ---

  private async getTrackedKeys(): Promise<string[]> {
    const raw = await NativeSecureStorage.getItem(KEY_INDEX);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async trackKey(key: string): Promise<void> {
    const keys = await this.getTrackedKeys();
    if (!keys.includes(key)) {
      keys.push(key);
      await NativeSecureStorage.setItem(KEY_INDEX, JSON.stringify(keys));
    }
  }

  private async untrackKey(key: string): Promise<void> {
    const keys = await this.getTrackedKeys();
    const filtered = keys.filter((k) => k !== key);
    if (filtered.length !== keys.length) {
      await NativeSecureStorage.setItem(KEY_INDEX, JSON.stringify(filtered));
    }
  }
}
