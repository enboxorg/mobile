import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function patchReactNativeLevelDb() {
  const gradlePath = resolve(
    process.cwd(),
    'node_modules/react-native-leveldb/android/build.gradle',
  );
  const iosCppPath = resolve(
    process.cwd(),
    'node_modules/react-native-leveldb/cpp/leveldb/util/env_posix.cc',
  );

  if (existsSync(gradlePath)) {
    const original = readFileSync(gradlePath, 'utf8');
    let next = original;

    // Remove the package-local buildscript block. It pulls in AGP 7.2.2 and
    // broken repositories, which fails modern RN/Gradle builds in CI.
    next = next.replace(
      /buildscript\s*\{[\s\S]*?^\}\n\n/m,
      '',
    );

    // Ensure google() is present alongside mavenCentral() for Android deps.
    next = next.replace(
      /repositories \{\n(\s*)mavenCentral\(\)\n\}/m,
      'repositories {\n$1google()\n$1mavenCentral()\n}',
    );

    if (next !== original) {
      writeFileSync(gradlePath, next, 'utf8');
      console.log('[postinstall] Patched react-native-leveldb/android/build.gradle');
    }
  }

  if (existsSync(iosCppPath)) {
    const original = readFileSync(iosCppPath, 'utf8');
    const next = original
      .replaceAll('std::memory_order::memory_order_relaxed', 'std::memory_order_relaxed');

    if (next !== original) {
      writeFileSync(iosCppPath, next, 'utf8');
      console.log('[postinstall] Patched react-native-leveldb/cpp/leveldb/util/env_posix.cc');
    }
  }
}

/**
 * Widen `EnboxUserAgent.create`'s `agentVault` parameter (and the matching
 * `AgentParams.agentVault` / `EnboxUserAgent.vault` fields) from the concrete
 * `HdIdentityVault` class to the already-exported `IdentityVault` interface.
 *
 * The ESM runtime at `dist/esm/enbox-user-agent.js` already short-circuits
 * with `agentVault ??= new HdIdentityVault(...)`, so the provided vault is
 * passed through unchanged when supplied. We therefore only need to widen the
 * type declarations. A runtime-side `IdentityVault` identifier would fail
 * because `IdentityVault` is only exported from the ambient types.
 *
 * Idempotent: detects the widened signature and skips. Tolerates missing
 * target files (e.g., `bun install --production` skips `dist/types`). Tolerates
 * upstream layout drift by checking for the expected `HdIdentityVault` tokens
 * before writing. Coexists with the `react-native-leveldb` patches above.
 */
function patchEnboxAgent() {
  const root = process.cwd();
  const agentRoot = resolve(root, 'node_modules/@enbox/agent');
  const targets = [
    {
      path: resolve(agentRoot, 'dist/types/enbox-user-agent.d.ts'),
      label: '@enbox/agent/dist/types/enbox-user-agent.d.ts',
    },
    {
      // Some future @enbox/agent versions may emit dual-format (.d.cts for
      // CommonJS). If present, widen it the same way.
      path: resolve(agentRoot, 'dist/types/enbox-user-agent.d.cts'),
      label: '@enbox/agent/dist/types/enbox-user-agent.d.cts',
    },
    {
      // Some bundlers (e.g., Metro with symlinked workspaces) resolve the
      // TypeScript source instead of the emitted .d.ts. Keep it coherent.
      path: resolve(agentRoot, 'src/enbox-user-agent.ts'),
      label: '@enbox/agent/src/enbox-user-agent.ts',
    },
  ];

  for (const { path, label } of targets) {
    if (!existsSync(path)) continue;
    const original = readFileSync(path, 'utf8');

    // Idempotence: already patched (both widened field declarations present).
    const widened =
      /agentVault: IdentityVault\b/.test(original) &&
      /(?:^|\s)vault: IdentityVault\b/m.test(original);
    if (widened) continue;

    // Drift guard: target tokens must be present before we rewrite.
    const hasAgentVaultToken = /agentVault: HdIdentityVault\b/.test(original);
    const hasVaultToken = /(?:^|\s)vault: HdIdentityVault\b/m.test(original);
    if (!hasAgentVaultToken || !hasVaultToken) {
      let version = 'unknown';
      try {
        const pkg = JSON.parse(
          readFileSync(resolve(agentRoot, 'package.json'), 'utf8'),
        );
        version = pkg.version ?? 'unknown';
      } catch {
        // ignore
      }
      console.warn(
        `[postinstall] Skipped ${label}: expected @enbox/agent HdIdentityVault tokens not found ` +
          `(installed version ${version}). Leaving file untouched.`,
      );
      continue;
    }

    let next = original
      .replace(/agentVault: HdIdentityVault\b/g, 'agentVault: IdentityVault')
      .replace(/(^|\s)vault: HdIdentityVault\b/gm, '$1vault: IdentityVault');

    // Add the type-only import for IdentityVault next to the HdIdentityVault
    // import, but only if not already present. The identity-vault module is
    // sibling of hd-identity-vault under `types/`.
    const importAlreadyPresent =
      /import type \{\s*IdentityVault\s*\} from ['"]\.\/types\/identity-vault\.js['"];?/.test(
        next,
      );
    if (!importAlreadyPresent) {
      const updated = next.replace(
        /(import \{ HdIdentityVault \} from ['"]\.\/hd-identity-vault\.js['"];)/,
        "import type { IdentityVault } from './types/identity-vault.js';\n$1",
      );
      if (updated === next) {
        // Import line did not match — skip to avoid half-patching the file.
        console.warn(
          `[postinstall] Skipped ${label}: HdIdentityVault import line not found; ` +
            'refusing to half-patch.',
        );
        continue;
      }
      next = updated;
    }

    if (next !== original) {
      writeFileSync(path, next, 'utf8');
      console.log(`[postinstall] Patched ${label}`);
    }
  }

  // Diagnostic: confirm the ESM runtime still carries the default HdIdentityVault
  // fallback. The ESM bundle itself does not need type changes; the `??=`
  // short-circuit already honors a caller-provided agentVault.
  const esmPath = resolve(agentRoot, 'dist/esm/enbox-user-agent.js');
  if (existsSync(esmPath)) {
    const esm = readFileSync(esmPath, 'utf8');
    if (!esm.includes('new HdIdentityVault(')) {
      console.warn(
        '[postinstall] Warning: @enbox/agent ESM missing `new HdIdentityVault(` fallback. ' +
          'No-arg EnboxUserAgent.create() may regress.',
      );
    }
  }
}

patchReactNativeLevelDb();
patchEnboxAgent();
