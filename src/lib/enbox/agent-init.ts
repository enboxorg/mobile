/**
 * Enbox Agent initialization for React Native.
 *
 * Configures the agent with:
 *   - RN-compatible LevelDB storage (via react-native-leveldb, intercepted via Metro)
 *   - Secure auth storage (via NativeSecureStorage Turbo Module)
 */

import { AgentDwnApi, EnboxUserAgent, LocalDwnDiscovery } from '@enbox/agent';
import { AuthManager } from '@enbox/auth';

import { SecureStorageAdapter } from './storage-adapter';

function patchAgentDwnApiForMobile() {
  const flag = '__enboxMobilePatchedAgentDwnApi';
  if ((globalThis as any)[flag]) {
    return;
  }

  const descriptor = Object.getOwnPropertyDescriptor(AgentDwnApi.prototype, 'agent');
  if (!descriptor?.set) {
    return;
  }

  Object.defineProperty(AgentDwnApi.prototype, 'agent', {
    ...descriptor,
    set(this: any, agent: any) {
      this._agent = agent;

      // Upstream eagerly creates LocalDwnDiscovery here even when strategy is
      // 'off', which triggers DwnDiscoveryFile and runtime require('node:*')
      // crashes on mobile. Skip discovery entirely for the mobile wallet.
      if (this._localDwnStrategy !== 'off') {
        try {
          this._localDwnDiscovery = new LocalDwnDiscovery(
            agent.rpc,
            10000,
            (AgentDwnApi as any)._tryCreateDiscoveryFile(),
          );
        } catch {
          this._localDwnDiscovery = undefined;
        }
      } else {
        this._localDwnDiscovery = undefined;
      }

      this._localManagedDidCache?.clear?.();
    },
  });

  (globalThis as any)[flag] = true;
  console.log('[agent-init] Patched AgentDwnApi.agent setter for mobile');
}

export async function initializeAgent() {
  patchAgentDwnApiForMobile();

  console.log('[agent-init] Creating auth manager...');
  const authManager = await AuthManager.create({
    storage: new SecureStorageAdapter(),
    localDwnStrategy: 'off',
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
