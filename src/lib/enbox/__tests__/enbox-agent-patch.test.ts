/// <reference types="node" />
/**
 * Contract tests for the @enbox/agent vault-injection patch emitted by
 * scripts/apply-patches.mjs.
 *
 * Three test surfaces:
 *
 *   1. File-content assertions on the patched node_modules files — the
 *      strongest guarantee that the patch widened the types without
 *      disturbing the runtime `HdIdentityVault` fallback.
 *
 *   2. Script behavior assertions (idempotence across repeated runs; graceful
 *      tolerance of a missing target file; coexistence with the existing
 *      react-native-leveldb patches).
 *
 *   3. A runtime simulation of the post-patch `EnboxUserAgent.create`
 *      short-circuit. Booting the real @enbox/agent runtime inside Jest is
 *      impractical (level/RN polyfills, WebCrypto, etc.), so we mirror the
 *      exact `agentVault ??= new HdIdentityVault(...)` pattern from the
 *      patched ESM and assert (a) a caller-supplied stub is referentially
 *      used as `agent.vault` without instantiating HdIdentityVault, and
 *      (b) the default path still produces an HdIdentityVault instance.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
const SCRIPT = resolve(ROOT, 'scripts/apply-patches.mjs');
const DTS = resolve(ROOT, 'node_modules/@enbox/agent/dist/types/enbox-user-agent.d.ts');
const ESM = resolve(ROOT, 'node_modules/@enbox/agent/dist/esm/enbox-user-agent.js');
const LEVELDB_GRADLE = resolve(ROOT, 'node_modules/react-native-leveldb/android/build.gradle');
const LEVELDB_ENV_POSIX = resolve(
  ROOT,
  'node_modules/react-native-leveldb/cpp/leveldb/util/env_posix.cc',
);

const sha256 = (p: string) =>
  createHash('sha256').update(readFileSync(p)).digest('hex');

const runScript = () => execFileSync('node', [SCRIPT], { cwd: ROOT, stdio: 'pipe' });

const runScriptCapture = (): string =>
  execFileSync('node', [SCRIPT], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

describe('@enbox/agent vault-injection patch (filesystem)', () => {
  it('widens AgentParams.agentVault and EnboxUserAgent.vault to IdentityVault in dist/types', () => {
    const dts = readFileSync(DTS, 'utf8');

    expect(dts).toMatch(/agentVault: IdentityVault\b/);
    expect(dts).toMatch(/(?:^|\s)vault: IdentityVault\b/m);
    expect(dts).not.toMatch(/agentVault: HdIdentityVault\b/);
    expect(dts).not.toMatch(/(?:^|\s)vault: HdIdentityVault\b/m);
    expect(dts).toMatch(
      /^import type \{ IdentityVault \} from '\.\/types\/identity-vault\.js';$/m,
    );
  });

  it('leaves the runtime ESM default HdIdentityVault fallback intact', () => {
    const esm = readFileSync(ESM, 'utf8');

    // Default construction branch is still present and still wires the
    // `${dataPath}/VAULT_STORE` LevelStore.
    expect(esm).toContain('new HdIdentityVault(');
    expect(esm).toContain('VAULT_STORE');

    // The `??=` short-circuit compiles to this exact pattern; losing it
    // would force HdIdentityVault construction even when the caller supplies
    // a vault, silently breaking injection.
    expect(esm).toMatch(/agentVault !== null && agentVault !== void 0/);

    // The ESM file must not acquire a runtime IdentityVault identifier —
    // IdentityVault is type-only. Matches `IdentityVault` not preceded by
    // `Hd` (so `HdIdentityVault` is not flagged).
    expect(esm).not.toMatch(/(?<!Hd)IdentityVault/);
  });

  it('preserves the existing react-native-leveldb patches alongside the vault patch', () => {
    expect(existsSync(LEVELDB_GRADLE)).toBe(true);
    expect(existsSync(LEVELDB_ENV_POSIX)).toBe(true);

    const gradle = readFileSync(LEVELDB_GRADLE, 'utf8');
    const envPosix = readFileSync(LEVELDB_ENV_POSIX, 'utf8');

    expect(gradle).not.toMatch(/^buildscript\s*\{/m);
    expect(gradle).toContain('google()');
    expect(envPosix).not.toContain('std::memory_order::memory_order_relaxed');
  });
});

describe('@enbox/agent vault-injection patch (script behavior)', () => {
  it('is idempotent — repeated invocations leave file hashes unchanged', () => {
    runScript();
    const before = { dts: sha256(DTS), esm: sha256(ESM) };
    runScript();
    const after = { dts: sha256(DTS), esm: sha256(ESM) };
    expect(after).toEqual(before);
  });

  it('tolerates a missing dist/types target without throwing', () => {
    const backup = DTS + '.test-bak';
    const stash = DTS + '.test-absent';
    copyFileSync(DTS, backup);
    renameSync(DTS, stash);
    try {
      expect(existsSync(DTS)).toBe(false);
      // The existsSync guard inside patchEnboxAgent must swallow the missing
      // file — no throw, normal exit.
      expect(() => runScript()).not.toThrow();
    } finally {
      if (existsSync(stash)) {
        renameSync(stash, DTS);
      }
      if (!existsSync(DTS) && existsSync(backup)) {
        copyFileSync(backup, DTS);
      }
      if (existsSync(backup)) {
        unlinkSync(backup);
      }
      // Ensure final on-disk state is fully patched for downstream tests.
      runScript();
    }
  });

  it('detects upstream layout drift gracefully and leaves the file untouched', () => {
    const backup = DTS + '.test-drift-bak';
    copyFileSync(DTS, backup);
    try {
      // Simulate drift: remove the two IdentityVault widened tokens AND the
      // HdIdentityVault tokens, so neither `widened` nor the drift-guard
      // succeeds — the script must skip.
      const drifted = readFileSync(DTS, 'utf8')
        .replace(/agentVault: IdentityVault\b/g, 'agentVault: SomethingElse')
        .replace(/(?:^|\s)vault: IdentityVault\b/gm, ' vault: SomethingElse');
      writeFileSync(DTS, drifted, 'utf8');
      const preHash = sha256(DTS);

      expect(() => runScript()).not.toThrow();

      // File must not have been mutated (no half-patch).
      expect(sha256(DTS)).toBe(preHash);
    } finally {
      copyFileSync(backup, DTS);
      unlinkSync(backup);
      runScript();
    }
  });
});

describe('postinstall patch logging (VAL-PATCH-001)', () => {
  it('emits a [postinstall] Patched line for @enbox/agent when the .d.ts is in a pre-patch state', () => {
    const backup = DTS + '.test-log-bak';
    copyFileSync(DTS, backup);
    try {
      // Simulate a fresh-install pre-patch state by restoring the upstream
      // HdIdentityVault tokens and stripping the IdentityVault type import.
      const preState = readFileSync(DTS, 'utf8')
        .replace(/agentVault: IdentityVault\b/g, 'agentVault: HdIdentityVault')
        .replace(/(^|\s)vault: IdentityVault\b/gm, '$1vault: HdIdentityVault')
        .replace(
          /^import type \{ IdentityVault \} from '\.\/types\/identity-vault\.js';\r?\n/m,
          '',
        );
      writeFileSync(DTS, preState, 'utf8');

      const stdout = runScriptCapture();
      expect(stdout).toContain(
        '[postinstall] Patched @enbox/agent/dist/types/enbox-user-agent.d.ts',
      );
      // The file should now actually be patched (log reflects a real write).
      const patched = readFileSync(DTS, 'utf8');
      expect(patched).toMatch(/agentVault: IdentityVault\b/);
    } finally {
      copyFileSync(backup, DTS);
      unlinkSync(backup);
      // Leave the file in a fully-patched state for downstream tests.
      runScript();
    }
  });

  it('emits a [postinstall] Patched line for react-native-leveldb gradle when the target needs patching', () => {
    const backup = LEVELDB_GRADLE + '.test-log-bak';
    copyFileSync(LEVELDB_GRADLE, backup);
    try {
      // Revert to a state where google() is absent from the repositories
      // block, matching what the patcher's regex expects to find pre-patch.
      const preState = readFileSync(LEVELDB_GRADLE, 'utf8').replace(
        /repositories \{\n(\s*)google\(\)\n\1mavenCentral\(\)\n\}/m,
        'repositories {\n$1mavenCentral()\n}',
      );
      expect(preState).not.toEqual(readFileSync(LEVELDB_GRADLE, 'utf8'));
      writeFileSync(LEVELDB_GRADLE, preState, 'utf8');

      const stdout = runScriptCapture();
      expect(stdout).toContain(
        '[postinstall] Patched react-native-leveldb/android/build.gradle',
      );
    } finally {
      copyFileSync(backup, LEVELDB_GRADLE);
      unlinkSync(backup);
      runScript();
    }
  });

  it('emits a [postinstall] Patched line for react-native-leveldb env_posix.cc when the C++ source needs patching', () => {
    const backup = LEVELDB_ENV_POSIX + '.test-log-bak';
    copyFileSync(LEVELDB_ENV_POSIX, backup);
    try {
      // Simulate the upstream libc++ incompatibility the patch fixes.
      const pre = readFileSync(LEVELDB_ENV_POSIX, 'utf8').replace(
        /std::memory_order_relaxed/g,
        'std::memory_order::memory_order_relaxed',
      );
      writeFileSync(LEVELDB_ENV_POSIX, pre, 'utf8');

      const stdout = runScriptCapture();
      expect(stdout).toContain(
        '[postinstall] Patched react-native-leveldb/cpp/leveldb/util/env_posix.cc',
      );
    } finally {
      copyFileSync(backup, LEVELDB_ENV_POSIX);
      unlinkSync(backup);
      runScript();
    }
  });

  it('emits no [postinstall] Patched lines on the idempotent repeat-run (all targets already patched)', () => {
    // Guarantee every target is in the patched state.
    runScript();
    const stdout = runScriptCapture();
    expect(stdout).not.toMatch(/\[postinstall\] Patched/);
  });
});

// ---------------------------------------------------------------------------
// Runtime simulation of the patched `EnboxUserAgent.create` short-circuit.
// ---------------------------------------------------------------------------
//
// The patched ESM compiles to:
//   agentVault !== null && agentVault !== void 0 ? agentVault : (agentVault = new HdIdentityVault({...}));
//   return new EnboxUserAgent({ agentVault, ... });
//
// i.e. when the caller supplies a vault, it is used as-is and HdIdentityVault
// is never instantiated. The reimplementation below is an exact replica, so
// the assertions verify the contract the runtime is bound to honor.

interface IdentityVaultLike {
  initialize: (...args: any[]) => Promise<unknown>;
  isLocked: () => boolean;
  [key: string]: unknown;
}

class FakeHdIdentityVault {
  static constructorCalls = 0;
  public readonly __isHd = true;
  constructor(_params: { keyDerivationWorkFactor: number; store: unknown }) {
    FakeHdIdentityVault.constructorCalls += 1;
  }
  initialize = async () => 'fake-hd';
  isLocked = () => true;
  [key: string]: unknown;
}

function simulatedCreate({
  agentVault,
}: { agentVault?: IdentityVaultLike } = {}): { vault: IdentityVaultLike } {
  const vault: IdentityVaultLike =
    agentVault ??
    new FakeHdIdentityVault({
      keyDerivationWorkFactor: 210_000,
      store: { location: 'DATA/AGENT/VAULT_STORE' },
    });
  return { vault };
}

describe('EnboxUserAgent.create vault injection (runtime simulation)', () => {
  beforeEach(() => {
    FakeHdIdentityVault.constructorCalls = 0;
  });

  it('(a) uses the caller-supplied stub as agent.vault and does NOT instantiate HdIdentityVault', () => {
    const stub: IdentityVaultLike = {
      backup: async () => ({ dateCreated: '', size: 0, data: '' }),
      changePassword: async () => undefined,
      getDid: async () => {
        throw new Error('stub');
      },
      getStatus: async () =>
        ({ initialized: false, lastBackup: null, lastRestore: null }) as const,
      initialize: async () => 'stub-recovery-phrase',
      isInitialized: async () => false,
      isLocked: () => true,
      lock: async () => undefined,
      restore: async () => undefined,
      unlock: async () => undefined,
      encryptData: async () => '',
      decryptData: async () => new Uint8Array(),
    };

    const agent = simulatedCreate({ agentVault: stub });

    expect(agent.vault).toBe(stub);
    expect(FakeHdIdentityVault.constructorCalls).toBe(0);
    expect(typeof agent.vault.initialize).toBe('function');
  });

  it('(b) default construction — no arg — produces an HdIdentityVault', () => {
    const agent = simulatedCreate();

    expect(agent.vault).toBeInstanceOf(FakeHdIdentityVault);
    expect(FakeHdIdentityVault.constructorCalls).toBe(1);
  });

  it('(b) default construction — explicit undefined — produces an HdIdentityVault', () => {
    const agent = simulatedCreate({ agentVault: undefined });

    expect(agent.vault).toBeInstanceOf(FakeHdIdentityVault);
    expect(FakeHdIdentityVault.constructorCalls).toBe(1);
  });
});
