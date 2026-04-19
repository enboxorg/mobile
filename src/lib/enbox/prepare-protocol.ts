import { DwnInterface, type DwnProtocolDefinition, getDwnServiceEndpointUrls } from '@enbox/agent';

type ProtocolQueryReply = {
  status: { code: number; detail: string };
  entries?: Array<{ definition?: DwnProtocolDefinition }>;
};

type PrepareProtocolAgent = {
  did: unknown;
  rpc: {
    sendDwnRequest: (params: {
      dwnUrl: string;
      targetDid: string;
      message: unknown;
    }) => Promise<{ status: { code: number; detail: string } }>;
  };
  processDwnRequest: (params: {
    author: string;
    target: string;
    messageType: string;
    messageParams: Record<string, unknown>;
    encryption?: true;
  }) => Promise<{ reply: ProtocolQueryReply; message?: unknown }>;
};

function getStructureNode(structure: Record<string, any> | undefined, protocolPath: string): Record<string, any> | undefined {
  if (!structure) return undefined;
  let current: Record<string, any> | undefined = structure;
  for (const segment of protocolPath.split('/')) {
    if (!current || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function protocolHasEncryptedTypes(protocolDefinition: DwnProtocolDefinition): boolean {
  return Object.values(protocolDefinition.types ?? {}).some((type: any) => type?.encryptionRequired === true);
}

export function hasEncryptionConfiguredForEncryptedTypes(
  installedDefinition: DwnProtocolDefinition | undefined,
  requestedDefinition: DwnProtocolDefinition,
): boolean {
  if (!installedDefinition) return false;

  for (const [protocolPath, typeDef] of Object.entries(requestedDefinition.types ?? {})) {
    if (!(typeDef as any)?.encryptionRequired) continue;
    const node = getStructureNode(installedDefinition.structure as Record<string, any> | undefined, protocolPath);
    if (!node || typeof node !== 'object' || !('$encryption' in node)) {
      return false;
    }
  }

  return true;
}

/**
 * Ensure the requested protocol is installed locally and on all owner DWN
 * endpoints, with `$encryption` keys present when encrypted types exist.
 */
export async function prepareProtocol(
  selectedDid: string,
  agent: PrepareProtocolAgent,
  protocolDefinition: DwnProtocolDefinition,
): Promise<void> {
  const queryResult = await agent.processDwnRequest({
    author: selectedDid,
    messageType: DwnInterface.ProtocolsQuery,
    target: selectedDid,
    messageParams: { filter: { protocol: protocolDefinition.protocol } },
  });

  if (queryResult.reply.status.code !== 200) {
    throw new Error(`Could not fetch protocol: ${queryResult.reply.status.detail}`);
  }

  const existingEntry = queryResult.reply.entries?.[0];
  const needsEncryption = protocolHasEncryptedTypes(protocolDefinition);
  const missingEncryption = needsEncryption
    && !hasEncryptionConfiguredForEncryptedTypes(existingEntry?.definition, protocolDefinition);

  let configureMessage: unknown;

  if (!existingEntry || missingEncryption) {
    const { message } = await agent.processDwnRequest({
      author: selectedDid,
      target: selectedDid,
      messageType: DwnInterface.ProtocolsConfigure,
      messageParams: { definition: protocolDefinition },
      encryption: needsEncryption || undefined,
    });
    configureMessage = message;
  } else {
    configureMessage = existingEntry;
  }

  const dwnEndpoints = await getDwnServiceEndpointUrls(selectedDid, agent.did as any);
  await Promise.all(dwnEndpoints.map(async (endpoint: string) => {
    try {
      const reply = await agent.rpc.sendDwnRequest({
        dwnUrl: endpoint,
        targetDid: selectedDid,
        message: configureMessage,
      });
      if (reply.status.code !== 202 && reply.status.code !== 409) {
        console.warn(`prepareProtocol: endpoint ${endpoint} rejected protocol: ${reply.status.detail}`);
      }
    } catch (err) {
      console.warn(`prepareProtocol: failed to send to ${endpoint}:`, err);
    }
  }));
}
