/// <reference types="node" />
/**
 * End-to-end smoke test for the @enbox/agent vault-injection patch.
 *
 * Unlike `enbox-agent-patch.test.ts` (which simulates the patched
 * `EnboxUserAgent.create` short-circuit locally), this test imports the
 * real patched `@enbox/agent` package from `node_modules/` and drives
 * `EnboxUserAgent.create({ agentVault: stubVault })` with a minimal
 * `IdentityVault` stub. It asserts:
 *
 *   1. `agent.vault === stubVault` (the patched `??=` short-circuit
 *      preserves referential identity when a vault is provided).
 *   2. `agent.initialize({ password: 'x' })` forwards to
 *      `stubVault.initialize` and returns its recovery phrase (no
 *      `HdIdentityVault` instantiation occurs).
 *   3. `agent.vault` is not an `HdIdentityVault` instance.
 *
 * Executing this as an in-process Jest test is impractical because
 * `@enbox/agent` is `"type": "module"` and chain-imports
 * `@enbox/dwn-clients`, `@enbox/dids`, `@enbox/common`, `level`, etc., all
 * of which Jest's CJS transform cannot consume (see
 * `jest.config.js#transformIgnorePatterns`, which only allowlists
 * `ed25519-keygen`). We therefore run the real import in a Node subprocess
 * via `--input-type=module -e`. The subprocess points at the same
 * `node_modules/@enbox/agent` that the mobile app loads, so the patch
 * applied by `scripts/apply-patches.mjs` is the exact surface under test.
 *
 * Fulfills the follow-up requirement from the patch-injection scrutiny
 * review: "The added runtime checks never import the real `@enbox/agent`
 * package or call `agent.initialize()`; they only assert a local
 * `simulatedCreate()` mirror of the short-circuit."
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
const AGENT_ESM = resolve(
  ROOT,
  'node_modules/@enbox/agent/dist/esm/enbox-user-agent.js',
);

// The Node subprocess script that imports the real @enbox/agent. Kept as a
// template string so the whole test stays in one file; the child process
// interprets it as an ES module via `--input-type=module`.
//
// Each dependency of the constructor (`cryptoApi`, `didApi`, `dwnApi`,
// `identityApi`, `keyManager`, `permissionsApi`, `rpcClient`, `syncApi`) is
// supplied as a plain object. The EnboxUserAgent constructor only assigns
// `.agent = this` to each of them; no methods on those APIs are invoked in
// this test. The wallet secret / vault lifecycle is exercised end-to-end
// through the stub's `initialize` which returns a marker recovery phrase.
const SUBPROCESS_SCRIPT = `
import { EnboxUserAgent, HdIdentityVault } from '@enbox/agent';

const calls = [];

const stub = {
  backup: async () => ({ dateCreated: '', size: 0, data: '' }),
  changePassword: async () => undefined,
  getDid: async () => { throw new Error('stub getDid not expected'); },
  getStatus: async () => ({ initialized: false, lastBackup: null, lastRestore: null }),
  initialize: async (params) => {
    calls.push({ method: 'initialize', params });
    return 'stub-recovery-phrase';
  },
  isInitialized: async () => false,
  isLocked: () => true,
  lock: async () => undefined,
  restore: async () => undefined,
  unlock: async () => undefined,
  encryptData: async () => '',
  decryptData: async () => new Uint8Array(),
};

// Plain-object stubs for all peer APIs so EnboxUserAgent.create does not
// fall back to its LevelDB-backed defaults (AgentDidApi, AgentDwnApi,
// SyncEngineLevel). The constructor only sets .agent on each of these.
const apiStub = () => ({});

try {
  const agent = await EnboxUserAgent.create({
    agentVault: stub,
    cryptoApi: apiStub(),
    didApi: apiStub(),
    dwnApi: apiStub(),
    identityApi: apiStub(),
    keyManager: apiStub(),
    permissionsApi: apiStub(),
    rpcClient: apiStub(),
    syncApi: apiStub(),
  });

  if (agent.vault !== stub) {
    console.error('E2E-FAIL: agent.vault is not the stub vault (injection lost)');
    process.exit(10);
  }
  if (agent.vault instanceof HdIdentityVault) {
    console.error('E2E-FAIL: agent.vault is an HdIdentityVault instance (default fallback fired)');
    process.exit(11);
  }
  if (typeof agent.vault.initialize !== 'function') {
    console.error('E2E-FAIL: agent.vault.initialize is not a function');
    process.exit(12);
  }

  const rp = await agent.initialize({ password: 'e2e-test' });
  if (rp !== 'stub-recovery-phrase') {
    console.error('E2E-FAIL: recovery phrase mismatch: ' + JSON.stringify(rp));
    process.exit(13);
  }
  if (calls.length !== 1 || calls[0].method !== 'initialize') {
    console.error('E2E-FAIL: stub.initialize not invoked exactly once: ' + JSON.stringify(calls));
    process.exit(14);
  }
  if (!calls[0].params || calls[0].params.password !== 'e2e-test') {
    console.error('E2E-FAIL: stub.initialize did not receive forwarded params: ' + JSON.stringify(calls[0]));
    process.exit(15);
  }

  console.log('E2E-OK');
  process.exit(0);
} catch (e) {
  console.error('E2E-FAIL (unexpected error):', e && (e.stack || e.message) || String(e));
  process.exit(99);
}
`;

describe('@enbox/agent vault-injection patch end-to-end (real import)', () => {
  // Gate: only run when the real patched package is on disk. If a future
  // @enbox/agent reorganization moves the ESM file, the e2e path cannot be
  // driven meaningfully and should be surfaced (via
  // whatWasLeftUndone) rather than a hard failure.
  const canRunE2E = existsSync(AGENT_ESM);

  (canRunE2E ? it : it.skip)(
    'uses the injected stub vault as agent.vault and forwards agent.initialize to it (no HdIdentityVault instantiation)',
    () => {
      // TODO(VAL-PATCH-e2e): if this test ever hits a resolution-time
      // blocker (e.g., an @enbox/agent peer suddenly fails to load in Node
      // because of a native dep), convert this back to it.skip and record
      // the reason in the next worker's whatWasLeftUndone — do not delete
      // silently. The contract assertion at stake is VAL-PATCH-004 /
      // VAL-PATCH-005.
      const result = spawnSync(
        'node',
        ['--input-type=module', '-e', SUBPROCESS_SCRIPT],
        {
          cwd: ROOT,
          encoding: 'utf8',
          // Allow a generous timeout: @enbox/agent's ESM chain pulls in
          // several dependencies on cold start. Typical observed runtime
          // on a developer laptop is ~1–3 seconds.
          timeout: 30_000,
        },
      );

      if (result.status !== 0) {
        // Surface both streams so failures diagnose cleanly in CI logs.
        throw new Error(
          `@enbox/agent e2e subprocess failed (status=${result.status}, signal=${result.signal})\n` +
            `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      expect(result.stdout).toContain('E2E-OK');
    },
    45_000,
  );
});
