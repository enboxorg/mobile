/**
 * Enbox Agent initialization for React Native.
 *
 * Configures the agent with:
 *   - RN-compatible LevelDB storage (via react-native-leveldb, intercepted via Metro)
 *   - Secure auth storage (via NativeSecureStorage Turbo Module)
 */

import { EnboxUserAgent } from '@enbox/agent';
import { AuthManager } from '@enbox/auth';

import { SecureStorageAdapter } from './storage-adapter';

export async function initializeAgent() {
  console.log('[agent-init] Creating auth manager...');
  const authManager = await AuthManager.create({
    storage: new SecureStorageAdapter(),
  });
  console.log('[agent-init] Auth manager created.');

  console.log('[agent-init] Creating agent...');
  const agent = await EnboxUserAgent.create({
    dataPath: 'ENBOX_AGENT',
    // Mobile wallet runs against remote DID-document endpoints.
    // Do not attempt local DWN discovery via filesystem (`~/.enbox/dwn.json`),
    // which is meant for CLI/native desktop flows and triggers Node built-in
    // requires (`node:fs/promises`, `node:path`, `node:os`).
    localDwnStrategy: 'off',
  });
  console.log('[agent-init] Agent created.');

  return { agent, authManager };
}
