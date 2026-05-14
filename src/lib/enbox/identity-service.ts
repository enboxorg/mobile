import type {
  BearerIdentity,
  DwnProtocolDefinition,
  EnboxUserAgent,
} from '@enbox/agent';
import type { ServerInfo } from '@enbox/dwn-clients';

import { SecureStorageAdapter } from './storage-adapter';

export const DEFAULT_DWN_ENDPOINTS: string[] = [
  'https://enbox-dwn.fly.dev',
  'https://dev.aws.dwn.enbox.id',
];

export const WEB_WALLET_URL = 'https://enbox-wallet.pages.dev';

const REGISTRATION_TOKENS_KEY = 'enbox.registration.tokens';
const ENABLE_IDENTITY_PROVISIONING_LOGS = process.env.ENBOX_DEBUG_AGENT === '1';
const SOCIAL_GRAPH_PROTOCOL_URI = 'https://identity.foundation/protocols/social-graph';
const PROFILE_PROTOCOL_URI = 'https://identity.foundation/protocols/profile';
const CONNECT_PROTOCOL_URI = 'https://identity.foundation/protocols/connect';

type RegistrationTokenData = {
  registrationToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenUrl?: string;
  refreshUrl?: string;
};

export interface CreateMobileIdentityParams {
  persona: string;
  displayName?: string;
  dwnEndpoints?: string[];
}

type DidUri = { uri: string };

type IdentityMetadataSummary = {
  name?: string;
  tenant?: string;
  uri?: string;
  connectedDid?: string;
};

type IdentityRecord = {
  did?: DidUri;
  metadata?: IdentityMetadataSummary;
};

type CreatedIdentity = IdentityRecord & {
  did: DidUri;
};

type MobileDidService = {
  id: 'dwn';
  type: 'DecentralizedWebNode';
  serviceEndpoint: string[];
  enc: '#enc';
  sig: '#sig';
};

type MobileDidVerificationMethod =
  | {
      algorithm: 'Ed25519';
      id: 'sig';
      purposes: ['assertionMethod', 'authentication'];
    }
  | {
      algorithm: 'X25519';
      id: 'enc';
      purposes: ['keyAgreement'];
    };

type MobileIdentityCreateOptions = {
  store: true;
  didMethod: 'dht';
  didOptions: {
    services: MobileDidService[];
    verificationMethods: MobileDidVerificationMethod[];
  };
  metadata: { name: string };
};

type ServerInfoSummary = Pick<ServerInfo, 'providerAuth' | 'registrationRequirements'>;
type ProviderAuthInfo = NonNullable<ServerInfoSummary['providerAuth']>;

type IdentityAgent = {
  agentDid?: DidUri;
  did?: {
    delete?: EnboxUserAgent['did']['delete'];
  };
  identity: {
    create(params: MobileIdentityCreateOptions): Promise<CreatedIdentity>;
    list(): Promise<IdentityRecord[]>;
    get?: EnboxUserAgent['identity']['get'];
    import?: EnboxUserAgent['identity']['import'];
    export?: EnboxUserAgent['identity']['export'];
    delete?: EnboxUserAgent['identity']['delete'];
    setMetadataName?: EnboxUserAgent['identity']['setMetadataName'];
  };
  processDwnRequest?: EnboxUserAgent['processDwnRequest'];
  rpc?: {
    getServerInfo?: (url: string) => Promise<ServerInfoSummary>;
    sendDwnRequest?: EnboxUserAgent['rpc']['sendDwnRequest'];
  };
  sync?: Partial<
    Pick<
      EnboxUserAgent['sync'],
      'registerIdentity' | 'unregisterIdentity' | 'startSync' | 'stopSync' | 'sync'
    >
  >;
};

function debugWarn(message: string, error?: unknown): void {
  if (!ENABLE_IDENTITY_PROVISIONING_LOGS) return;
  console.warn(message, error);
}

function loadEnboxApi(): typeof import('@enbox/api') {
  return require('@enbox/api') as typeof import('@enbox/api');
}

function loadProtocols(): typeof import('@enbox/protocols') {
  try {
    return require('@enbox/protocols') as typeof import('@enbox/protocols');
  } catch (err) {
    debugWarn('Falling back to inline protocol metadata:', err);
    return {
      SocialGraphDefinition: { protocol: SOCIAL_GRAPH_PROTOCOL_URI },
      ProfileDefinition: { protocol: PROFILE_PROTOCOL_URI },
      ConnectDefinition: { protocol: CONNECT_PROTOCOL_URI },
      ProfileProtocol: { protocol: PROFILE_PROTOCOL_URI },
      ConnectProtocol: { protocol: CONNECT_PROTOCOL_URI },
    } as unknown as typeof import('@enbox/protocols');
  }
}

function loadDwnRegistrar(): typeof import('@enbox/dwn-clients').DwnRegistrar {
  return require('@enbox/dwn-clients').DwnRegistrar as typeof import('@enbox/dwn-clients').DwnRegistrar;
}

function asEnboxUserAgent(agent: IdentityAgent): EnboxUserAgent {
  return agent as unknown as EnboxUserAgent;
}

function normalizeEndpoints(endpoints: string[] | undefined): string[] {
  const values = endpoints?.map((endpoint) => endpoint.trim()).filter(Boolean);
  return values && values.length > 0 ? values : [...DEFAULT_DWN_ENDPOINTS];
}

function getIdentityDid(identity: IdentityRecord): string {
  const did = identity?.did?.uri ?? identity?.metadata?.uri;
  if (typeof did !== 'string' || did.length === 0) {
    throw new Error('Created identity did not include a DID URI');
  }
  return did;
}

function supportsDwnProvisioning(agent: IdentityAgent): boolean {
  return (
    typeof agent?.processDwnRequest === 'function' &&
    typeof agent?.rpc?.sendDwnRequest === 'function'
  );
}

function loadRequiredProtocols(): readonly DwnProtocolDefinition[] {
  const {
    ConnectDefinition,
    ProfileDefinition,
    SocialGraphDefinition,
  } = loadProtocols();

  return [
    SocialGraphDefinition,
    ProfileDefinition,
    ConnectDefinition,
  ] as const;
}

function requiredProtocolUris(): string[] {
  return loadRequiredProtocols().map((definition) => definition.protocol);
}

async function registerSyncIdentity(
  agent: IdentityAgent,
  did: string,
  protocols?: string[],
): Promise<boolean> {
  if (!agent.sync?.registerIdentity) return false;
  try {
    await agent.sync.registerIdentity({
      did,
      ...(protocols ? { options: { protocols } } : {}),
    });
    return true;
  } catch {
    // Already registered or unavailable offline.
    return false;
  }
}

export async function startWalletSync(agent: IdentityAgent): Promise<void> {
  if (!agent.sync?.startSync) return;
  try {
    await agent.sync.startSync({ mode: 'live', interval: '5m' });
  } catch (err) {
    debugWarn('Failed to start wallet sync:', err);
  }
}

export async function stopWalletSync(agent: IdentityAgent): Promise<void> {
  if (!agent.sync?.stopSync) return;
  try {
    await agent.sync.stopSync(2000);
  } catch (err) {
    debugWarn('Failed to stop wallet sync:', err);
  }
}

export async function ensurePostSession(
  agent: IdentityAgent,
  endpoints: string[] = DEFAULT_DWN_ENDPOINTS,
): Promise<void> {
  try {
    await ensureRegistration(agent, normalizeEndpoints(endpoints));
  } catch (err) {
    debugWarn('Post-session DWN registration failed:', err);
  }

  if (agent.agentDid?.uri) {
    await registerSyncIdentity(agent, agent.agentDid.uri);
  }

  if (agent.sync?.registerIdentity) {
    const protocolUris = requiredProtocolUris();
    try {
      const identities = await agent.identity.list();
      for (const identity of identities) {
        const did = identity.metadata?.connectedDid ?? identity.did?.uri ?? identity.metadata?.uri;
        if (did) {
          await registerSyncIdentity(agent, did, protocolUris);
        }
      }
    } catch (err) {
      debugWarn('Post-session identity sync registration failed:', err);
    }
  }

  await startWalletSync(agent);
}

export async function recoverWalletFromSync(
  agent: IdentityAgent,
  endpoints: string[] = DEFAULT_DWN_ENDPOINTS,
): Promise<void> {
  const canRegisterSync = typeof agent.sync?.registerIdentity === 'function';
  const canPullSync = typeof agent.sync?.sync === 'function';
  const canProvisionDwn = supportsDwnProvisioning(agent);

  if (!canRegisterSync && !canPullSync && !canProvisionDwn) {
    await startWalletSync(agent);
    return;
  }

  const dwnEndpoints = normalizeEndpoints(endpoints);
  const protocolDefinitions = loadRequiredProtocols();
  const protocolUris = protocolDefinitions.map((definition) => definition.protocol);

  try {
    await ensureRegistration(agent, dwnEndpoints);
  } catch (err) {
    debugWarn('Restore DWN registration failed before sync pull:', err);
  }

  await stopWalletSync(agent);

  if (agent.agentDid?.uri) {
    await registerSyncIdentity(agent, agent.agentDid.uri);
  }

  if (agent.sync?.sync) {
    try {
      await agent.sync.sync('pull');
    } catch (err) {
      debugWarn('Restore identity-metadata pull failed:', err);
    }
  }

  let identities: IdentityRecord[] = [];
  try {
    identities = await agent.identity.list();
  } catch (err) {
    debugWarn('Restore identity list after metadata pull failed:', err);
  }

  for (const identity of identities) {
    const did = identity.metadata?.connectedDid ?? identity.did?.uri ?? identity.metadata?.uri;
    if (did) {
      await registerSyncIdentity(agent, did, protocolUris);
    }
  }

  try {
    await ensureRegistration(agent, dwnEndpoints);
  } catch (err) {
    debugWarn('Restore DWN registration failed after identity pull:', err);
  }

  if (agent.sync?.sync) {
    try {
      await agent.sync.sync('pull');
    } catch (err) {
      debugWarn('Restore profile/data pull failed:', err);
    }
  }

  try {
    identities = await agent.identity.list();
  } catch (err) {
    debugWarn('Restore identity list after data pull failed:', err);
  }

  if (canProvisionDwn) {
    for (const identity of identities) {
      const did = identity.did?.uri ?? identity.metadata?.uri;
      if (!did) continue;
      try {
        await installIdentityProtocols(agent, did, protocolDefinitions);
      } catch (err) {
        debugWarn(`Restore protocol install for ${did} failed:`, err);
      }
    }
  }

  if (agent.sync?.sync) {
    try {
      await agent.sync.sync('push');
    } catch (err) {
      debugWarn('Restore protocol push failed:', err);
    }
  }

  await startWalletSync(agent);
}

async function readRegistrationTokens(
  storage = new SecureStorageAdapter(),
): Promise<Record<string, RegistrationTokenData>> {
  const raw = await storage.get(REGISTRATION_TOKENS_KEY);
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, RegistrationTokenData>)
      : {};
  } catch {
    return {};
  }
}

async function writeRegistrationTokens(
  tokens: Record<string, RegistrationTokenData>,
  storage = new SecureStorageAdapter(),
): Promise<void> {
  await storage.set(REGISTRATION_TOKENS_KEY, JSON.stringify(tokens));
}

function isTokenExpired(token: RegistrationTokenData): boolean {
  if (!token.expiresAt) return false;
  return Date.now() >= token.expiresAt - 60_000;
}

function randomState(): string {
  const crypto = globalThis.crypto;

  if (crypto?.randomUUID) return crypto.randomUUID();

  if (!crypto?.getRandomValues) {
    throw new Error('Secure random source unavailable');
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function obtainProviderAuthToken(
  dwnEndpoint: string,
  providerAuth: ProviderAuthInfo,
): Promise<RegistrationTokenData> {
  const state = randomState();
  const separator = providerAuth.authorizeUrl.includes('?') ? '&' : '?';
  const authorizeUrl =
    `${providerAuth.authorizeUrl}${separator}` +
    `redirect_uri=${encodeURIComponent(dwnEndpoint)}` +
    `&state=${encodeURIComponent(state)}`;

  const res = await fetch(authorizeUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Provider auth authorize failed (${res.status}): ${await res.text()}`);
  }

  const { code, state: returnedState } = (await res.json()) as {
    code: string;
    state: string;
  };
  if (returnedState !== state) {
    throw new Error('Provider auth state mismatch');
  }

  const DwnRegistrar = loadDwnRegistrar();
  const tokenResponse = await DwnRegistrar.exchangeAuthCode(
    providerAuth.tokenUrl,
    code,
    dwnEndpoint,
  );

  return {
    registrationToken: tokenResponse.registrationToken,
    refreshToken: tokenResponse.refreshToken,
    expiresAt:
      tokenResponse.expiresIn != null
        ? Date.now() + tokenResponse.expiresIn * 1000
        : undefined,
    tokenUrl: providerAuth.tokenUrl,
    refreshUrl: providerAuth.refreshUrl,
  };
}

async function ensureValidRegistrationToken(
  dwnEndpoint: string,
  providerAuth: ProviderAuthInfo,
  tokens: Record<string, RegistrationTokenData>,
): Promise<RegistrationTokenData> {
  let token = tokens[dwnEndpoint];

  if (token && isTokenExpired(token) && token.refreshUrl && token.refreshToken) {
    const DwnRegistrar = loadDwnRegistrar();
    const refreshed = await DwnRegistrar.refreshRegistrationToken(
      token.refreshUrl,
      token.refreshToken,
    );
    token = {
      ...token,
      registrationToken: refreshed.registrationToken,
      refreshToken: refreshed.refreshToken ?? token.refreshToken,
      expiresAt: refreshed.expiresIn
        ? Date.now() + refreshed.expiresIn * 1000
        : token.expiresAt,
    };
  } else if (!token || isTokenExpired(token)) {
    token = await obtainProviderAuthToken(dwnEndpoint, providerAuth);
  }

  tokens[dwnEndpoint] = token;
  return token;
}

async function registerDidWithEndpoint(
  agent: IdentityAgent,
  endpoint: string,
  did: string,
  serverInfo: ServerInfoSummary,
  tokens: Record<string, RegistrationTokenData>,
): Promise<Record<string, RegistrationTokenData>> {
  const updated = { ...tokens };
  const requiresProviderAuth =
    serverInfo.registrationRequirements?.includes('provider-auth-v0') &&
    serverInfo.providerAuth !== undefined;

  if (requiresProviderAuth) {
    const DwnRegistrar = loadDwnRegistrar();
    const token = await ensureValidRegistrationToken(
      endpoint,
      serverInfo.providerAuth!,
      updated,
    );
    await DwnRegistrar.registerTenantWithToken(
      endpoint,
      did,
      token.registrationToken,
    );
  } else {
    const DwnRegistrar = loadDwnRegistrar();
    await DwnRegistrar.registerTenant(endpoint, did);
  }

  return updated;
}

async function ensureRegistration(
  agent: IdentityAgent,
  endpoints: string[],
): Promise<void> {
  if (!agent?.rpc?.getServerInfo || !agent?.agentDid?.uri) return;

  const identities = await agent.identity.list();
  const dids = new Set<string>([agent.agentDid.uri]);
  for (const identity of identities) {
    const did = identity.metadata?.connectedDid ?? identity.did?.uri;
    if (did) dids.add(did);
  }

  let tokens = await readRegistrationTokens();

  for (const endpoint of endpoints) {
    try {
      const serverInfo = await agent.rpc.getServerInfo(endpoint);
      for (const did of dids) {
        try {
          tokens = await registerDidWithEndpoint(
            agent,
            endpoint,
            did,
            serverInfo,
            tokens,
          );
        } catch (err) {
          debugWarn(`DWN registration of ${did} with ${endpoint} failed:`, err);
        }
      }
    } catch (err) {
      debugWarn(`Could not reach DWN endpoint ${endpoint} for registration:`, err);
    }
  }

  await writeRegistrationTokens(tokens);
}

async function installIdentityProtocols(
  agent: IdentityAgent,
  did: string,
  protocolDefinitions: readonly DwnProtocolDefinition[],
): Promise<void> {
  const { Enbox, defineProtocol } = loadEnboxApi();
  const enbox = new Enbox({ agent: asEnboxUserAgent(agent), connectedDid: did });

  for (const definition of protocolDefinitions) {
    const typed = enbox.using(defineProtocol(definition));
    const result = await typed.configure();
    const status = result?.status;

    if (!status || status.code >= 300) {
      throw new Error(
        `Failed to install protocol ${definition.protocol}: ${
          status?.code ?? 'unknown'
        } ${status?.detail ?? 'no status returned'}`,
      );
    }

    if (result?.protocol && status.code === 202) {
      try {
        const { status: sendStatus } = await result.protocol.send(did);
        if (sendStatus.code >= 300) {
          debugWarn(
            `Protocol remote send for ${definition.protocol}: ${sendStatus.code} ${sendStatus.detail}`,
          );
        }
      } catch (err) {
        debugWarn(`Protocol remote send failed for ${definition.protocol}:`, err);
      }
    }
  }
}

async function writeInitialProfile(
  agent: IdentityAgent,
  did: string,
  displayName: string,
): Promise<void> {
  const { Enbox, repository } = loadEnboxApi();
  const { ProfileProtocol } = loadProtocols();
  const enbox = new Enbox({ agent: asEnboxUserAgent(agent), connectedDid: did });
  const repo = repository(enbox.using(ProfileProtocol));
  const { record } = await repo.profile.set({
    data: { displayName },
    published: true,
  });
  await record?.send();
}

async function createWalletRecord(agent: IdentityAgent, did: string): Promise<void> {
  try {
    const { Enbox } = loadEnboxApi();
    const { ConnectProtocol } = loadProtocols();
    const enbox = new Enbox({ agent: asEnboxUserAgent(agent), connectedDid: did });
    const connect = enbox.using(ConnectProtocol);
    const { records } = await connect.records.query('wallet');
    if (records.length > 0) return;

    const { record } = await connect.records.create('wallet', {
      data: {
        webWallets: [WEB_WALLET_URL],
      },
    });
    await record?.send();
  } catch (err) {
    debugWarn('Failed to create wallet record:', err);
  }
}

export async function createMobileIdentity(
  agent: IdentityAgent,
  params: CreateMobileIdentityParams,
) {
  const persona = params.persona.trim();
  if (!persona) throw new Error('Identity name is required');

  const displayName = params.displayName?.trim() || persona;
  const dwnEndpoints = normalizeEndpoints(params.dwnEndpoints);

  const identity = await agent.identity.create({
    store: true,
    didMethod: 'dht',
    didOptions: {
      services: [
        {
          id: 'dwn',
          type: 'DecentralizedWebNode',
          serviceEndpoint: dwnEndpoints,
          enc: '#enc',
          sig: '#sig',
        },
      ],
      verificationMethods: [
        {
          algorithm: 'Ed25519',
          id: 'sig',
          purposes: ['assertionMethod', 'authentication'],
        },
        {
          algorithm: 'X25519',
          id: 'enc',
          purposes: ['keyAgreement'],
        },
      ],
    },
    metadata: { name: persona },
  });

  const did = getIdentityDid(identity);
  const shouldProvisionDwn = supportsDwnProvisioning(agent);
  const protocolDefinitions =
    shouldProvisionDwn || agent.sync?.registerIdentity
      ? loadRequiredProtocols()
      : [];
  const protocolUris = requiredProtocolUris();

  if (agent.agentDid?.uri) {
    await registerSyncIdentity(agent, agent.agentDid.uri);
  }

  await registerSyncIdentity(agent, did, protocolUris);

  if (shouldProvisionDwn) {
    await ensureRegistration(agent, dwnEndpoints);
    await installIdentityProtocols(agent, did, protocolDefinitions);
    await writeInitialProfile(agent, did, displayName);
    await createWalletRecord(agent, did);
  }

  await startWalletSync(agent);

  return identity as BearerIdentity;
}

export async function importMobileIdentity(
  agent: IdentityAgent,
  portableIdentity: any,
): Promise<BearerIdentity> {
  if (!agent.identity.import) {
    throw new Error('Identity import is not available');
  }

  const did =
    portableIdentity?.portableDid?.uri ??
    portableIdentity?.did?.uri ??
    portableIdentity?.metadata?.uri;
  if (typeof did !== 'string' || did.length === 0) {
    throw new Error('Imported identity is missing a DID URI');
  }

  if (agent.identity.get) {
    const existing = await agent.identity.get({ didUri: did });
    if (existing) throw new Error(`Identity already exists: ${did}`);
  }

  const identity = await agent.identity.import({ portableIdentity });
  const importedDid = getIdentityDid(identity);
  const protocolDefinitions = loadRequiredProtocols();
  const protocolUris = protocolDefinitions.map((definition) => definition.protocol);

  if (agent.agentDid?.uri) {
    await registerSyncIdentity(agent, agent.agentDid.uri);
  }
  await registerSyncIdentity(agent, importedDid, protocolUris);
  if (supportsDwnProvisioning(agent)) {
    await ensureRegistration(agent, DEFAULT_DWN_ENDPOINTS);
    await installIdentityProtocols(agent, importedDid, protocolDefinitions);
    await createWalletRecord(agent, importedDid);
  }
  await startWalletSync(agent);

  return identity as BearerIdentity;
}

export async function updateMobileIdentityName(
  agent: IdentityAgent,
  did: string,
  name: string,
): Promise<void> {
  const nextName = name.trim();
  if (!nextName) throw new Error('Identity name is required');
  if (!agent.identity.setMetadataName) {
    throw new Error('Identity metadata updates are not available');
  }

  await agent.identity.setMetadataName({ didUri: did, name: nextName });

  try {
    await writeInitialProfile(agent, did, nextName);
  } catch (err) {
    debugWarn(`Profile update for ${did} failed:`, err);
  }

  await startWalletSync(agent);
}

export async function deleteMobileIdentity(
  agent: IdentityAgent,
  did: string,
): Promise<void> {
  if (!agent.identity.delete) {
    throw new Error('Identity delete is not available');
  }

  if (agent.sync?.unregisterIdentity) {
    try {
      await agent.sync.unregisterIdentity(did);
    } catch (err) {
      debugWarn(`Sync unregister for ${did} failed:`, err);
    }
  }

  await agent.identity.delete({ didUri: did });

  if (agent.did?.delete && agent.agentDid?.uri) {
    try {
      await agent.did.delete({ didUri: did, tenant: agent.agentDid.uri });
    } catch (err) {
      debugWarn(`DID delete for ${did} failed:`, err);
    }
  }

  await startWalletSync(agent);
}
