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

import NativeBiometricVault from '@specs/NativeBiometricVault';

import { initializeAgent } from './agent-init';
import {
  BiometricVault,
  WALLET_ROOT_KEY_ALIAS,
  type BiometricState,
} from './biometric-vault';

/** Error code emitted by the biometric vault when the OS cannot satisfy a biometric prompt. */
const BIOMETRICS_UNAVAILABLE_CODE = 'VAULT_ERROR_BIOMETRICS_UNAVAILABLE';
/** Error code emitted by the biometric vault when the key was invalidated by the OS. */
const KEY_INVALIDATED_CODE = 'VAULT_ERROR_KEY_INVALIDATED';

export interface AgentStore {
  agent: EnboxUserAgent | null;
  authManager: AuthManager | null;
  vault: BiometricVault | null;
  isInitializing: boolean;
  error: string | null;
  /**
   * Last observed biometric state surfaced by the native vault. Stays
   * `null` until the vault reports a definitive state or a flow observes
   * a key-invalidated error. Consumers gate onboarding/restore UI on
   * `'invalidated'` / `'not-enrolled'` / `'unavailable'`.
   */
  biometricState: BiometricState | null;
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

  /**
   * Clear the one-shot recovery phrase from the store. Must be called by
   * the UI after the user confirms they have backed up the phrase so the
   * 24 words are no longer resident in JS memory.
   */
  clearRecoveryPhrase: () => void;

  /** Create a new identity. */
  createIdentity: (name: string) => Promise<BearerIdentity>;

  /** Tear down agent (on lock or reset). */
  teardown: () => void;

  /**
   * Full wallet reset. Deletes the biometric-gated native secret, clears
   * the in-memory agent store (`teardown`), and clears persisted session
   * state (`useSessionStore.reset`). Idempotent — safe to call multiple
   * times even if no vault is initialized.
   *
   * After reset, a subsequent `initializeFirstLaunch()` starts onboarding
   * from scratch and will yield a new (different) mnemonic and DID.
   */
  reset: () => Promise<void>;
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
  biometricState: null,
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

      set({
        agent,
        authManager,
        vault,
        isInitializing: false,
        recoveryPhrase,
        biometricState: 'ready',
      });
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
      let nextBiometricState = get().biometricState;
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        nextBiometricState = 'unavailable';
      } else if (code === KEY_INVALIDATED_CODE) {
        nextBiometricState = 'invalidated';
      }
      set({
        error: message,
        isInitializing: false,
        agent: null,
        authManager: null,
        vault: null,
        biometricState: nextBiometricState,
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
      set({
        agent,
        authManager,
        vault,
        isInitializing: false,
        biometricState: 'ready',
      });

      get().refreshIdentities().catch(() => {});
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      const message = messageFromError(err, 'Agent unlock failed');
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        console.warn('[agent-store] unlock blocked: biometrics unavailable');
      } else if (code === KEY_INVALIDATED_CODE) {
        console.warn('[agent-store] unlock blocked: biometric key invalidated');
      } else {
        console.error('[agent-store] unlock failed:', message);
      }
      let nextBiometricState = get().biometricState;
      if (code === BIOMETRICS_UNAVAILABLE_CODE) {
        nextBiometricState = 'unavailable';
      } else if (code === KEY_INVALIDATED_CODE) {
        nextBiometricState = 'invalidated';
      }
      set({
        error: message,
        isInitializing: false,
        agent: null,
        authManager: null,
        vault: null,
        biometricState: nextBiometricState,
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

  clearRecoveryPhrase: () => {
    set({ recoveryPhrase: null });
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

  reset: async () => {
    const { vault } = get();

    // 1. Wipe the biometric-gated native secret. Use the vault's own
    //    reset() when available (also clears vault SecureStorage flags);
    //    fall back to a direct native deleteSecret call so reset remains
    //    useful even if the vault was never constructed (e.g. after a
    //    corrupt-start scenario).
    if (vault) {
      try {
        await vault.reset();
      } catch (err) {
        console.warn('[agent-store] reset: vault.reset failed:', err);
      }
    } else {
      try {
        await NativeBiometricVault.deleteSecret(WALLET_ROOT_KEY_ALIAS);
      } catch (err) {
        console.warn(
          '[agent-store] reset: native deleteSecret failed (ignored):',
          err,
        );
      }
    }

    // 2. Tear down the in-memory agent / authManager / vault state and
    //    null out the one-shot recovery phrase if it was still held.
    get().teardown();

    // 3. Clear persisted session state + PIN-era storage artefacts. The
    //    import lives inside the function to avoid a circular import at
    //    module load time (session-store ↔ agent-store).
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { useSessionStore } = require('@/features/session/session-store');
      await useSessionStore.getState().reset();
    } catch (err) {
      console.warn('[agent-store] reset: session-store reset failed:', err);
    }
  },
}));
