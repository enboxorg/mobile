jest.mock(
  '@enbox/protocols',
  () => ({
    __esModule: true,
    SocialGraphDefinition: { protocol: 'https://enbox.test/protocols/social' },
    ProfileDefinition: { protocol: 'https://enbox.test/protocols/profile' },
    ConnectDefinition: { protocol: 'https://enbox.test/protocols/connect' },
    ProfileProtocol: { kind: 'profile' },
    ConnectProtocol: { kind: 'connect' },
  }),
  { virtual: true },
);

const mockConfigure = jest.fn();
const mockProtocolSend = jest.fn();
const mockProfileSet = jest.fn();
const mockProfileSend = jest.fn();
const mockWalletQuery = jest.fn();
const mockWalletCreate = jest.fn();
const mockWalletSend = jest.fn();
const mockDefineProtocol = jest.fn((definition) => ({
  kind: 'definition',
  definition,
}));

jest.mock(
  '@enbox/api',
  () => ({
    __esModule: true,
    defineProtocol: mockDefineProtocol,
    Enbox: jest.fn().mockImplementation(() => ({
      using: jest.fn((input) => {
        if (input?.kind === 'definition') {
          return { configure: mockConfigure };
        }
        if (input?.kind === 'connect') {
          return {
            records: {
              query: mockWalletQuery,
              create: mockWalletCreate,
            },
          };
        }
        return { kind: 'profileRepo' };
      }),
    })),
    repository: jest.fn(() => ({
      profile: {
        set: mockProfileSet,
      },
    })),
  }),
  { virtual: true },
);

const mockRegisterTenant = jest.fn();

jest.mock(
  '@enbox/dwn-clients',
  () => ({
    __esModule: true,
    DwnRegistrar: {
      registerTenant: mockRegisterTenant,
      registerTenantWithToken: jest.fn(),
      exchangeAuthCode: jest.fn(),
      refreshRegistrationToken: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.mock('@/lib/enbox/storage-adapter', () => ({
  SecureStorageAdapter: jest.fn().mockImplementation(() => ({
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
  })),
}));

import {
  DEFAULT_DWN_ENDPOINTS,
  WEB_WALLET_URL,
  createMobileIdentity,
} from '@/lib/enbox/identity-service';

describe('createMobileIdentity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigure.mockResolvedValue({
      status: { code: 202, detail: 'Accepted' },
      protocol: { send: mockProtocolSend },
    });
    mockProtocolSend.mockResolvedValue({ status: { code: 202, detail: 'Accepted' } });
    mockProfileSet.mockResolvedValue({ record: { send: mockProfileSend } });
    mockProfileSend.mockResolvedValue(undefined);
    mockWalletQuery.mockResolvedValue({ records: [] });
    mockWalletCreate.mockResolvedValue({ record: { send: mockWalletSend } });
    mockWalletSend.mockResolvedValue(undefined);
    mockRegisterTenant.mockResolvedValue(undefined);
  });

  it('creates a DID:DHT identity with DWN services and provisions wallet protocols/profile metadata', async () => {
    const identityCreate = jest.fn(async () => ({
      did: { uri: 'did:dht:alice' },
      metadata: { uri: 'did:dht:alice', name: 'Alice' },
    }));
    const identityList = jest.fn(async () => [
      { did: { uri: 'did:dht:alice' }, metadata: { uri: 'did:dht:alice' } },
    ]);
    const registerIdentity = jest.fn(async () => undefined);
    const getServerInfo = jest.fn(async () => ({ registrationRequirements: [] }));
    const sendDwnRequest = jest.fn(async () => ({
      status: { code: 202, detail: 'Accepted' },
    }));

    const agent = {
      agentDid: { uri: 'did:dht:agent' },
      identity: {
        create: identityCreate,
        list: identityList,
      },
      sync: {
        registerIdentity,
      },
      rpc: {
        getServerInfo,
        sendDwnRequest,
      },
      processDwnRequest: jest.fn(),
    };

    const identity = await createMobileIdentity(agent, {
      persona: 'Alice',
      displayName: 'Alice A.',
    });

    expect(identity.did.uri).toBe('did:dht:alice');
    expect(identityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        store: true,
        didMethod: 'dht',
        metadata: { name: 'Alice' },
        didOptions: expect.objectContaining({
          services: [
            expect.objectContaining({
              id: 'dwn',
              type: 'DecentralizedWebNode',
              serviceEndpoint: DEFAULT_DWN_ENDPOINTS,
              enc: '#enc',
              sig: '#sig',
            }),
          ],
          verificationMethods: expect.arrayContaining([
            expect.objectContaining({ algorithm: 'Ed25519', id: 'sig' }),
            expect.objectContaining({ algorithm: 'X25519', id: 'enc' }),
          ]),
        }),
      }),
    );
    expect(registerIdentity).toHaveBeenCalledWith({
      did: 'did:dht:alice',
      options: {
        protocols: [
          'https://enbox.test/protocols/social',
          'https://enbox.test/protocols/profile',
          'https://enbox.test/protocols/connect',
        ],
      },
    });
    expect(mockConfigure).toHaveBeenCalledTimes(3);
    expect(mockProtocolSend).toHaveBeenCalledTimes(3);
    expect(mockProfileSet).toHaveBeenCalledWith({
      data: { displayName: 'Alice A.' },
      published: true,
    });
    expect(mockWalletCreate).toHaveBeenCalledWith('wallet', {
      data: { webWallets: [WEB_WALLET_URL] },
    });
    expect(mockRegisterTenant).toHaveBeenCalled();
  });
});
