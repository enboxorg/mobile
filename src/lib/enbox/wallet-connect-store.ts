import { create } from 'zustand';
import { CryptoUtils } from '@enbox/crypto';
import type { EnboxConnectRequest } from '@enbox/agent';
import { EnboxConnectProtocol } from '@enbox/agent';

import { prepareProtocol } from './prepare-protocol';

export type WalletConnectPhase =
  | 'idle'
  | 'loading'
  | 'request'
  | 'authorizing'
  | 'pin'
  | 'done'
  | 'error';

export interface PendingWalletConnect {
  rawUrl: string;
  requestUri: string;
  encryptionKey: string;
  request: EnboxConnectRequest;
}

export interface WalletConnectStore {
  phase: WalletConnectPhase;
  pending: PendingWalletConnect | null;
  generatedPin: string | null;
  error: string | null;

  handleIncomingUrl: (url: string) => Promise<void>;
  approve: (selectedDid: string, agent: any) => Promise<void>;
  deny: () => Promise<void>;
  clear: () => void;
}

export function parseConnectUrl(rawUrl: string): { requestUri: string; encryptionKey: string } {
  const url = new URL(rawUrl);
  const isConnect = url.protocol === 'enbox:' && (url.hostname === 'connect' || url.pathname === '/connect');
  if (!isConnect) {
    throw new Error('Unsupported wallet link');
  }

  const requestUri = url.searchParams.get('request_uri');
  const encryptionKey = url.searchParams.get('encryption_key');

  if (!requestUri || !encryptionKey) {
    throw new Error('Invalid connection URI: missing request_uri or encryption_key');
  }

  return { requestUri, encryptionKey };
}

export const useWalletConnectStore = create<WalletConnectStore>((set, get) => ({
  phase: 'idle',
  pending: null,
  generatedPin: null,
  error: null,

  handleIncomingUrl: async (rawUrl) => {
    set({ phase: 'loading', error: null });
    try {
      const { requestUri, encryptionKey } = parseConnectUrl(rawUrl);
      const request = await EnboxConnectProtocol.getConnectRequest(requestUri, encryptionKey);
      set({
        phase: 'request',
        pending: { rawUrl, requestUri, encryptionKey, request },
        generatedPin: null,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process connection request';
      console.error('[wallet-connect] incoming URL failed:', err);
      set({ phase: 'error', error: message, pending: null, generatedPin: null });
    }
  },

  approve: async (selectedDid, agent) => {
    const pending = get().pending;
    if (!pending) {
      throw new Error('No pending connect request');
    }

    set({ phase: 'authorizing', error: null });
    try {
      for (const permissionRequest of pending.request.permissionRequests) {
        await prepareProtocol(selectedDid, agent, permissionRequest.protocolDefinition);
      }

      const pin = CryptoUtils.randomPin({ length: 4 });
      await EnboxConnectProtocol.submitConnectResponse(selectedDid, pending.request, pin, agent);

      set({ phase: 'pin', generatedPin: pin, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to authorize connection';
      console.error('[wallet-connect] approval failed:', err);
      set({ phase: 'error', error: message });
      throw err;
    }
  },

  deny: async () => {
    const pending = get().pending;
    if (!pending) {
      get().clear();
      return;
    }

    try {
      await fetch(pending.request.callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          id_token: 'DENIED',
          state: pending.request.state,
        }).toString(),
      });
    } catch {
      // Best effort only.
    }

    get().clear();
  },

  clear: () => {
    set({ phase: 'idle', pending: null, generatedPin: null, error: null });
  },
}));
