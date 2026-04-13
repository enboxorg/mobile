/**
 * Global agent store.
 *
 * Manages the Enbox agent lifecycle:
 * - First launch: creates agent, initializes vault with PIN as password
 * - Return visit: creates agent, unlocks vault with PIN
 * - Lock: tears down agent (vault CEK cleared from memory)
 * - Reset: tears down agent + wipes vault storage
 */

import { create } from 'zustand';
import type { EnboxUserAgent, BearerIdentity } from '@enbox/agent';
import type { AuthManager } from '@enbox/auth';

import { initializeAgent } from './agent-init';

export interface AgentStore {
  agent: EnboxUserAgent | null;
  authManager: AuthManager | null;
  isInitializing: boolean;
  error: string | null;
  recoveryPhrase: string | null;
  identities: BearerIdentity[];

  /** First launch: initialize vault + create agent DID. Returns recovery phrase. */
  initializeFirstLaunch: (password: string) => Promise<string>;

  /** Return visit: unlock existing vault. */
  unlockAgent: (password: string) => Promise<void>;

  /** Refresh identities list from the agent. */
  refreshIdentities: () => Promise<void>;

  /** Create a new identity. */
  createIdentity: (name: string) => Promise<BearerIdentity>;

  /** Tear down agent (on lock or reset). */
  teardown: () => void;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agent: null,
  authManager: null,
  isInitializing: false,
  error: null,
  recoveryPhrase: null,
  identities: [],

  initializeFirstLaunch: async (password) => {
    set({ isInitializing: true, error: null });
    try {
      const { agent, authManager } = await initializeAgent();
      const isFirst = await agent.firstLaunch();

      let recoveryPhrase: string;
      if (isFirst) {
        recoveryPhrase = await agent.initialize({ password });
      } else {
        await agent.start({ password });
        recoveryPhrase = '';
      }

      set({ agent, authManager, isInitializing: false, recoveryPhrase });
      return recoveryPhrase;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Agent initialization failed';
      console.error('[agent] first launch failed:', err);
      set({ error: message, isInitializing: false });
      throw err;
    }
  },

  unlockAgent: async (password) => {
    set({ isInitializing: true, error: null });
    try {
      const { agent, authManager } = await initializeAgent();
      await agent.start({ password });
      set({ agent, authManager, isInitializing: false });

      // Load identities in background
      get().refreshIdentities().catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Agent unlock failed';
      console.error('[agent] unlock failed:', err);
      set({ error: message, isInitializing: false });
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
      isInitializing: false,
      error: null,
      recoveryPhrase: null,
      identities: [],
    });
  },
}));
