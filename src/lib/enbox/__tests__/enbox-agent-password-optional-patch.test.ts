/// <reference types="node" />
/**
 * Contract tests for the @enbox/agent password-optional widening patch
 * emitted by `scripts/apply-patches.mjs` (`patchEnboxAgentPasswordOptional`).
 *
 * The BiometricVault replacement ignores `password` entirely (it prompts
 * biometrics via the native module). The upstream `AgentInitializeParams` /
 * `AgentStartParams` types, however, still require a `password: string`
 * field, which forces `@ts-expect-error` at every call site. This patch
 * rewrites those two type declarations to `password?: string` so the call
 * sites typecheck cleanly with `agent.initialize({})` / `agent.start({})`.
 *
 * Three test surfaces (mirroring the existing vault-injection patch tests):
 *
 *   1. File-content assertions on the patched node_modules files — the
 *      strongest guarantee that the two `password: string;` declarations
 *      inside `AgentInitializeParams` and `AgentStartParams` were widened
 *      to `password?: string;`.
 *
 *   2. Script behavior assertions (idempotence across repeated runs; graceful
 *      tolerance of a missing target file; graceful tolerance of upstream
 *      layout drift; coexistence with the vault-injection and
 *      react-native-leveldb patches).
 *
 *   3. A TypeScript-surface compile-time assertion that passing an empty
 *      object literal to the widened types is legal. This mirrors the
 *      real call sites in `src/lib/enbox/agent-store.ts`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
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

import type {
  AgentInitializeParams,
  AgentStartParams,
} from '@enbox/agent';

const ROOT = resolve(__dirname, '../../../..');
const SCRIPT = resolve(ROOT, 'scripts/apply-patches.mjs');
const DTS = resolve(ROOT, 'node_modules/@enbox/agent/dist/types/enbox-user-agent.d.ts');
const SRC_TS = resolve(ROOT, 'node_modules/@enbox/agent/src/enbox-user-agent.ts');
const LEVELDB_GRADLE = resolve(ROOT, 'node_modules/react-native-leveldb/android/build.gradle');

const sha256 = (p: string) =>
  createHash('sha256').update(readFileSync(p)).digest('hex');

const runScript = () => execFileSync('node', [SCRIPT], { cwd: ROOT, stdio: 'pipe' });

const runScriptCapture = (): string =>
  execFileSync('node', [SCRIPT], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

const runScriptCaptureAll = (): {
  stdout: string;
  stderr: string;
  status: number | null;
} => {
  const result = spawnSync('node', [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
};

describe('@enbox/agent password-optional widening patch (filesystem)', () => {
  it('widens AgentInitializeParams.password and AgentStartParams.password to optional in dist/types', () => {
    const dts = readFileSync(DTS, 'utf8');

    // Both original `password: string;` declarations must have been
    // rewritten — there must be no remaining strict `password: string;`
    // tokens.
    expect(dts).not.toMatch(/^\s*password: string;$/m);

    // Both declarations must now be optional.
    const optionalMatches = dts.match(/^\s*password\?: string;$/gm) ?? [];
    expect(optionalMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('widens AgentInitializeParams.password and AgentStartParams.password to optional in the TS source', () => {
    // The `src/*.ts` file is a secondary target kept coherent with the
    // emitted types so bundlers (e.g. Metro with symlinked workspaces)
    // that resolve the TypeScript source see the widened shape too.
    expect(existsSync(SRC_TS)).toBe(true);
    const src = readFileSync(SRC_TS, 'utf8');
    expect(src).not.toMatch(/^\s*password: string;$/m);
    const optionalMatches = src.match(/^\s*password\?: string;$/gm) ?? [];
    expect(optionalMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves earlier vault-injection patch (IdentityVault widening) alongside the password widening', () => {
    const dts = readFileSync(DTS, 'utf8');
    expect(dts).toMatch(/agentVault: IdentityVault\b/);
    expect(dts).toMatch(/(?:^|\s)vault: IdentityVault\b/m);
    expect(dts).toMatch(
      /^import type \{ IdentityVault \} from '\.\/types\/identity-vault\.js';$/m,
    );
  });

  it('preserves the existing react-native-leveldb gradle patch alongside the password widening', () => {
    expect(existsSync(LEVELDB_GRADLE)).toBe(true);
    const gradle = readFileSync(LEVELDB_GRADLE, 'utf8');
    expect(gradle).not.toMatch(/^buildscript\s*\{/m);
    expect(gradle).toContain('google()');
  });
});

describe('@enbox/agent password-optional widening patch (script behavior)', () => {
  it('is idempotent — repeated invocations leave file hashes unchanged', () => {
    runScript();
    const before = { dts: sha256(DTS), src: sha256(SRC_TS) };
    runScript();
    const after = { dts: sha256(DTS), src: sha256(SRC_TS) };
    expect(after).toEqual(before);
  });

  it('emits a [postinstall] Patched (password-optional) line when the .d.ts is in a pre-patch state', () => {
    const backup = DTS + '.pwd-test-log-bak';
    copyFileSync(DTS, backup);
    try {
      // Simulate a fresh-install pre-patch state by reverting the two
      // `password?: string;` declarations back to the upstream strict shape.
      const preState = readFileSync(DTS, 'utf8').replace(
        /^(\s*)password\?: string;$/gm,
        '$1password: string;',
      );
      writeFileSync(DTS, preState, 'utf8');

      const stdout = runScriptCapture();
      expect(stdout).toContain(
        '[postinstall] Patched @enbox/agent/dist/types/enbox-user-agent.d.ts (password-optional)',
      );
      // The file must now actually be patched (log reflects a real write).
      const patched = readFileSync(DTS, 'utf8');
      expect(patched).not.toMatch(/^\s*password: string;$/m);
      expect(patched).toMatch(/^\s*password\?: string;$/m);
    } finally {
      copyFileSync(backup, DTS);
      unlinkSync(backup);
      // Leave the file in a fully-patched state for downstream tests.
      runScript();
    }
  });

  it('tolerates a missing dist/types target without throwing', () => {
    const stash = DTS + '.pwd-test-absent';
    const backup = DTS + '.pwd-test-absent-bak';
    copyFileSync(DTS, backup);
    renameSync(DTS, stash);
    try {
      expect(existsSync(DTS)).toBe(false);
      // The existsSync guard must swallow the missing file — no throw,
      // normal exit, missing-target warn on stderr.
      const result = runScriptCaptureAll();
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        `[apply-patches] @enbox/agent password-optional target missing: ${DTS}; skipping (layout drift?)`,
      );
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

  it('detects upstream layout drift (unexpected token count) and leaves the file untouched', () => {
    const backup = DTS + '.pwd-test-drift-bak';
    copyFileSync(DTS, backup);
    try {
      // Simulate drift: remove one of the two widened tokens AND do not
      // re-introduce the strict form, so strictMatches.length is 0 and
      // the idempotence short-circuit also fails (only one widened
      // match remains). The drift guard must skip instead of writing.
      const drifted = readFileSync(DTS, 'utf8').replace(
        /^(\s*)password\?: string;$/m,
        '$1pwword?: string;',
      );
      writeFileSync(DTS, drifted, 'utf8');
      const preHash = sha256(DTS);

      const result = runScriptCaptureAll();
      expect(result.status).toBe(0);
      // Drift guard warning must surface on stderr.
      expect(result.stderr).toContain('password-optional widening');

      // File must not have been mutated (no half-patch).
      expect(sha256(DTS)).toBe(preHash);
    } finally {
      copyFileSync(backup, DTS);
      unlinkSync(backup);
      runScript();
    }
  });

  it('does not emit a (password-optional) Patched line on the idempotent repeat-run (all targets already patched)', () => {
    // Guarantee every target is in the patched state.
    runScript();
    const stdout = runScriptCapture();
    expect(stdout).not.toMatch(/\[postinstall\] Patched .* \(password-optional\)/);
  });
});

describe('@enbox/agent AgentInitializeParams / AgentStartParams compile-time surface', () => {
  it('accepts an empty object literal for AgentInitializeParams (type-level)', () => {
    // Pure type assertion — if the widening is in effect, `password` is
    // optional and the following line typechecks. If the widening
    // regresses, `tsc` fails and `bun run typecheck` goes red, which
    // would fail this test's suite at compile time.
    const init: AgentInitializeParams = {};
    expect(init).toBeDefined();
  });

  it('accepts an empty object literal for AgentStartParams (type-level)', () => {
    const start: AgentStartParams = {};
    expect(start).toBeDefined();
  });

  it('still accepts a populated AgentInitializeParams (recoveryPhrase only, no password)', () => {
    const init: AgentInitializeParams = { recoveryPhrase: 'word '.repeat(24).trim() };
    expect(init.recoveryPhrase).toBeDefined();
  });
});
