/**
 * Enbox Agent initialization for React Native.
 *
 * Configures the agent with:
 *   - RN-compatible LevelDB storage (via react-native-leveldb, intercepted via Metro)
 *   - Secure auth storage (via NativeSecureStorage Turbo Module)
 *   - No browser connect handler (to be replaced with mobile-native flow)
 */

import { EnboxUserAgent } from '@enbox/agent';
import { AuthManager } from '@enbox/auth';

import { SecureStorageAdapter } from './storage-adapter';

export async function initializeAgent() {
  // Auth manager with secure storage adapter backed by Keychain/Keystore
  const authManager = await AuthManager.create({
    storage: new SecureStorageAdapter(),
  });

  // Agent creation — the `level` import inside @enbox/* packages is
  // intercepted by Metro (see metro.config.js) and redirected to our
  // RNLevel adapter backed by react-native-leveldb.
  const agent = await EnboxUserAgent.create({
    // dataPath is used internally to construct LevelDB store paths.
    dataPath: 'ENBOX_AGENT',
  });

  return { agent, authManager };
}
