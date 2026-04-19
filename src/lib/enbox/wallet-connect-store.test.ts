import { EnboxConnectProtocol } from '@enbox/agent';
import { CryptoUtils } from '@enbox/crypto';

import { useWalletConnectStore, parseConnectUrl } from '@/lib/enbox/wallet-connect-store';
import { prepareProtocol } from '@/lib/enbox/prepare-protocol';

jest.mock('@enbox/agent', () => ({
  EnboxConnectProtocol: {
    getConnectRequest: jest.fn(),
    submitConnectResponse: jest.fn(),
  },
}), { virtual: true });

jest.mock('@enbox/crypto', () => ({
  CryptoUtils: {
    randomPin: jest.fn(() => '1234'),
  },
}), { virtual: true });

jest.mock('@/lib/enbox/prepare-protocol', () => ({
  prepareProtocol: jest.fn().mockResolvedValue(undefined),
}));

const mockedGetConnectRequest = EnboxConnectProtocol.getConnectRequest as jest.MockedFunction<typeof EnboxConnectProtocol.getConnectRequest>;
const mockedSubmitConnectResponse = EnboxConnectProtocol.submitConnectResponse as jest.MockedFunction<typeof EnboxConnectProtocol.submitConnectResponse>;
const mockedRandomPin = CryptoUtils.randomPin as jest.MockedFunction<typeof CryptoUtils.randomPin>;
const mockedPrepareProtocol = prepareProtocol as jest.MockedFunction<typeof prepareProtocol>;

beforeEach(() => {
  jest.clearAllMocks();
  useWalletConnectStore.getState().clear();
});

describe('parseConnectUrl', () => {
  it('parses a valid enbox connect link', () => {
    expect(
      parseConnectUrl('enbox://connect?request_uri=https%3A%2F%2Frelay.example%2Frequest%2Fabc&encryption_key=xyz'),
    ).toEqual({
      requestUri: 'https://relay.example/request/abc',
      encryptionKey: 'xyz',
    });
  });

  it('rejects unsupported links', () => {
    expect(() => parseConnectUrl('https://example.com')).toThrow('Unsupported wallet link');
  });

  it('rejects incomplete links', () => {
    expect(() => parseConnectUrl('enbox://connect?request_uri=foo')).toThrow(
      'Invalid connection URI: missing request_uri or encryption_key',
    );
  });
});

describe('useWalletConnectStore', () => {
  const sampleRequest = {
    appName: 'Nutsd',
    callbackUrl: 'https://relay.example/callback',
    state: 'state-123',
    permissionRequests: [
      {
        protocolDefinition: { protocol: 'https://enbox.id/protocols/cashu-wallet', types: {} },
        permissionScopes: [
          { interface: 'Records', method: 'Read', protocol: 'https://enbox.id/protocols/cashu-wallet' },
        ],
      },
    ],
  } as any;

  it('loads a pending connect request from a deep link', async () => {
    mockedGetConnectRequest.mockResolvedValue(sampleRequest);

    await useWalletConnectStore.getState().handleIncomingUrl(
      'enbox://connect?request_uri=https%3A%2F%2Frelay.example%2Frequest%2Fabc&encryption_key=xyz',
    );

    const state = useWalletConnectStore.getState();
    expect(mockedGetConnectRequest).toHaveBeenCalledWith('https://relay.example/request/abc', 'xyz');
    expect(state.phase).toBe('request');
    expect(state.pending?.request).toBe(sampleRequest);
  });

  it('stores an error when incoming URL processing fails', async () => {
    mockedGetConnectRequest.mockRejectedValue(new Error('bad request'));

    await useWalletConnectStore.getState().handleIncomingUrl(
      'enbox://connect?request_uri=https%3A%2F%2Frelay.example%2Frequest%2Fabc&encryption_key=xyz',
    );

    const state = useWalletConnectStore.getState();
    expect(state.phase).toBe('error');
    expect(state.error).toBe('bad request');
  });

  it('approves a pending request and generates a PIN', async () => {
    mockedGetConnectRequest.mockResolvedValue(sampleRequest);

    await useWalletConnectStore.getState().handleIncomingUrl(
      'enbox://connect?request_uri=https%3A%2F%2Frelay.example%2Frequest%2Fabc&encryption_key=xyz',
    );

    await useWalletConnectStore.getState().approve('did:dht:alice', { rpc: {}, did: {}, processDwnRequest: jest.fn() });

    const state = useWalletConnectStore.getState();
    expect(mockedPrepareProtocol).toHaveBeenCalledWith(
      'did:dht:alice',
      expect.any(Object),
      sampleRequest.permissionRequests[0].protocolDefinition,
    );
    expect(mockedRandomPin).toHaveBeenCalledWith({ length: 4 });
    expect(mockedSubmitConnectResponse).toHaveBeenCalledWith(
      'did:dht:alice',
      sampleRequest,
      '1234',
      expect.any(Object),
    );
    expect(state.phase).toBe('pin');
    expect(state.generatedPin).toBe('1234');
  });

  it('clears state on deny even if relay post is best-effort', async () => {
    mockedGetConnectRequest.mockResolvedValue(sampleRequest);
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;

    await useWalletConnectStore.getState().handleIncomingUrl(
      'enbox://connect?request_uri=https%3A%2F%2Frelay.example%2Frequest%2Fabc&encryption_key=xyz',
    );

    await useWalletConnectStore.getState().deny();

    const state = useWalletConnectStore.getState();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://relay.example/callback',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(state.phase).toBe('idle');
    expect(state.pending).toBeNull();
  });
});
