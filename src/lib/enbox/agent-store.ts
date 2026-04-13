/**
 * Global agent store.
 *
 * The Enbox agent is initialized once after the user unlocks the wallet.
 * It is torn down on lock or reset.
 */

import { create } from 'zustand';
import type { EnboxUserAgent } from '@enbox/agent';
import type { AuthManager } from '@enbox/auth';

import { initializeAgent } from './agent-init';

export interface AgentStore {
  agent: EnboxUserAgent | null;
  authManager: AuthManager | null;
  isInitializing: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  teardown: () => void;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agent: null,
  authManager: null,
  isInitializing: false,
  error: null,

  initialize: async () => {
    if (get().agent || get().isInitializing) return;

    set({ isInitializing: true, error: null });
    try {
      const { agent, authManager } = await initializeAgent();
      set({ agent, authManager, isInitializing: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Agent initialization failed';
      console.error('[agent] init failed:', err);
      set({ error: message, isInitializing: false });
    }
  },

  teardown: () => {
    set({ agent: null, authManager: null, isInitializing: false, error: null });
  },
}));
