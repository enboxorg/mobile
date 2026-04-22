/**
 * Enbox Agent initialization for React Native.
 *
 * Configures the agent with:
 *   - RN-compatible LevelDB storage (via react-native-leveldb, intercepted via Metro)
 *   - Secure auth storage (via NativeSecureStorage Turbo Module)
 *   - Biometric-first IdentityVault (BiometricVault) supplied as `agentVault`
 *     so `EnboxUserAgent.create` does NOT fall back to the legacy
 *     password-based default identity vault on mobile.
 */

import { AgentDwnApi, EnboxUserAgent, LocalDwnDiscovery } from '@enbox/agent';
import { AuthManager } from '@enbox/auth';

import { BiometricVault } from './biometric-vault';
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

/**
 * Build the biometric vault used by the mobile agent. Constructed with
 * the `SecureStorageAdapter` so the vault can persist its one-bit
 * `initialized` / `biometric-state` flags through @enbox/auth storage.
 */
export function createBiometricVault(): BiometricVault {
  return new BiometricVault({ secureStorage: new SecureStorageAdapter() });
}

export async function initializeAgent() {
  patchAgentDwnApiForMobile();

  console.log('[agent-init] Creating auth manager...');
  const authManager = await AuthManager.create({
    storage: new SecureStorageAdapter(),
    localDwnStrategy: 'off',
  });
  console.log('[agent-init] Auth manager created.');

  console.log('[agent-init] Creating biometric vault...');
  const vault = createBiometricVault();

  console.log('[agent-init] Creating agent...');
  const agent = await EnboxUserAgent.create({
    dataPath: 'ENBOX_AGENT',
    // Mobile wallet runs against remote DID-document endpoints.
    // Do not attempt local DWN discovery via filesystem (`~/.enbox/dwn.json`),
    // which is meant for CLI/native desktop flows and triggers Node built-in
    // requires (`node:fs/promises`, `node:path`, `node:os`).
    localDwnStrategy: 'off',
    // Inject the biometric-first IdentityVault so EnboxUserAgent.create
    // does NOT fall back to the legacy password-based default. The
    // injected vault's own `initialize({})` / `unlock({})` methods call
    // the native biometric TurboModule; passwords flowing through
    // `agent.initialize({ password })` / `agent.start({ password })`
    // are ignored by BiometricVault.
    agentVault: vault,
  });
  console.log('[agent-init] Agent created.');

  return { agent, authManager, vault };
}
