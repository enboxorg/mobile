/**
 * Global agent store.
 *
 * Manages the Enbox agent lifecycle:
 * - First launch: creates agent, initializes the biometric vault (prompts
 *   biometrics through the native module) and returns the generated
 *   recovery phrase.
 * - Return visit: creates agent, unlocks the biometric vault (prompts
 *   biometrics through the native module). No password is involved.
 * - Lock: tears down agent + vault (biometrics required on next launch).
 * - Reset: tears down agent + wipes vault storage.
 */

import { create } from 'zustand';
import type { EnboxUserAgent, BearerIdentity } from '@enbox/agent';
import type { AuthManager } from '@enbox/auth';

import { initializeAgent } from './agent-init';
import type { BiometricVault } from './biometric-vault';

/** Error code emitted by the biometric vault when the OS cannot satisfy a biometric prompt. */
const BIOMETRICS_UNAVAILABLE_CODE = 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE';

export interface AgentStore {
  agent: EnboxUserAgent | null;
  authManager: AuthManager | null;
  vault: BiometricVault | null;
  isInitializing: boolean;
  error: string | null;
  recoveryPhrase: string | null;
  identities: BearerIdentity[];

  /**
   * First launch: initialize the biometric vault + create agent DID.
   * Takes NO password — the vault prompts biometrics through the native
   * module. Returns the non-empty recovery phrase produced by the vault.
   */
  initializeFirstLaunch: () => Promise<string>;

  /**
   * Return visit: unlock the biometric vault. Takes NO password — the
   * vault prompts biometrics through the native module.
   */
  unlockAgent: () => Promise<void>;

  /** Refresh identities list from the agent. */
  refreshIdentities: () => Promise<void>;

  /** Clear the last agent error. */
  clearError: () => void;

  /** Create a new identity. */
  createIdentity: (name: string) => Promise<BearerIdentity>;

  /** Tear down agent (on lock or reset). */
  teardown: () => void;
}

/**
 * Preserve the native error's `.code` while wrapping it into a short
 * store-facing error string. We intentionally re-throw the original
 * error so the caller still receives `.code === 'VAULT_ERROR_*'`.
 */
function messageFromError(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return err.message ? `${code}: ${err.message}` : code;
    }
    if (err.message) {
      return err.message;
    }
  }
  return fallback;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agent: null,
  authManager: null,
  vault: null,
  isInitializing: false,
  error: null,
  recoveryPhrase: null,
  identities: [],

  initializeFirstLaunch: async () => {
    set({ isInitializing: true, error: null });
    try {
      console.log('[agent-store] initializeFirstLaunch: creating agent...');
      const { agent, authManager, vault } = await initializeAgent();

      console.log('[agent-store] checking firstLaunch...');
      const isFirst = await agent.firstLaunch();
      console.log('[agent-store] firstLaunch:', isFirst);

      let recoveryPhrase: string;
      if (isFirst) {
        console.log('[agent-store] initializing vault (biometric prompt)...');
        // BiometricVault ignores `password`; we pass an empty string to
        // satisfy the upstream `AgentInitializeParams` TypeScript shape.
        recoveryPhrase = await agent.initialize({ password: '' });
        console.log('[agent-store] vault initialized.');
      } else {
        console.log('[agent-store] starting existing vault (biometric prompt)...');
        await agent.start({ password: '' });
        recoveryPhrase = '';
      }

      set({ agent, authManager, vault, isInitializing: false, recoveryPhrase });
      get().refreshIdentities().catch(() => {});
      return recoveryPhrase;
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      const message = messageFromError(err, 'Agent initialization failed');
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        console.warn('[agent-store] first launch blocked: biometrics unavailable');
      } else {
        console.error('[agent-store] first launch failed:', message);
      }
      set({
        error: message,
        isInitializing: false,
        agent: null,
        authManager: null,
        vault: null,
      });
      throw err;
    }
  },

  unlockAgent: async () => {
    set({ isInitializing: true, error: null });
    try {
      console.log('[agent-store] unlockAgent: creating agent...');
      const { agent, authManager, vault } = await initializeAgent();
      console.log('[agent-store] starting vault (biometric prompt)...');
      // BiometricVault ignores `password`; empty string satisfies the
      // upstream `AgentStartParams` TypeScript shape.
      await agent.start({ password: '' });
      console.log('[agent-store] vault started.');
      set({ agent, authManager, vault, isInitializing: false });

      get().refreshIdentities().catch(() => {});
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      const message = messageFromError(err, 'Agent unlock failed');
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        console.warn('[agent-store] unlock blocked: biometrics unavailable');
      } else {
        console.error('[agent-store] unlock failed:', message);
      }
      set({
        error: message,
        isInitializing: false,
        agent: null,
        authManager: null,
        vault: null,
      });
      throw err;
    }
  },

  refreshIdentities: async () => {
    const { agent } = get();
    if (!agent) return;

    try {
      const identities = await agent.identity.list();
      set({ identities });
    } catch (err) {
      console.warn('[agent] identity list failed:', err);
    }
  },

  clearError: () => {
    set({ error: null });
  },

  createIdentity: async (name) => {
    const { agent } = get();
    if (!agent) throw new Error('Agent not initialized');

    const identity = await agent.identity.create({
      metadata: { name },
      didMethod: 'dht',
    });

    // Refresh the list
    await get().refreshIdentities();
    return identity;
  },

  teardown: () => {
    set({
      agent: null,
      authManager: null,
      vault: null,
      isInitializing: false,
      error: null,
      recoveryPhrase: null,
      identities: [],
    });
  },
}));
