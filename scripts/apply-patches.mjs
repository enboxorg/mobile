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

  // Observability pass: emit a clear warning for every targeted file that is
  // absent. This makes upstream layout drift visible in postinstall output
  // without failing the install (exit code stays 0). The ESM runtime file is
  // also considered an observability target even though it is not rewritten
  // (only read below as a diagnostic).
  const observabilityTargets = [
    ...targets.map((t) => t.path),
    resolve(agentRoot, 'dist/esm/enbox-user-agent.js'),
  ];
  for (const path of observabilityTargets) {
    if (!existsSync(path)) {
      console.warn(
        `[apply-patches] @enbox/agent target missing: ${path}; skipping (layout drift?)`,
      );
    }
  }

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

/**
 * Gate `react-native-camera-kit`'s iOS-26-only `isDeferredStartSupported` /
 * `isDeferredStartEnabled` calls behind a runtime (KVC / `responds(to:)`)
 * lookup so the file compiles against the CI runner's Xcode 16.4 / SDK 18.5
 * toolchain.
 *
 * Upstream `RealCamera.swift` already wraps the code in
 * `guard #available(iOS 26.0, *) else { return }`, but that is a *runtime*
 * check — the Swift compiler still needs the iOS 26 API surface on
 * `AVCapturePhotoOutput` / `AVCaptureMetadataOutput` to typecheck. On the
 * CI runner (`macos-15`, Xcode 16.4, SDK 18.5), those properties don't yet
 * exist in the framework headers, and the build fails with:
 *
 *     value of type 'AVCapturePhotoOutput' has no member
 *     'isDeferredStartSupported'
 *
 * We sidestep the compile-time dependency by calling the APIs through
 * Key-Value Coding. The existing `#available(iOS 26.0, *)` runtime guard
 * above this block keeps us from invoking the selectors on older iOS
 * versions where the underlying properties are absent.
 *
 * Idempotent: a unique marker line guards re-entry. Tolerates a missing
 * target file (warns + returns). Tolerates upstream layout drift by
 * checking for the expected original block before rewriting; if it isn't
 * there, the file is left alone.
 */
function patchReactNativeCameraKit() {
  const target = resolve(
    process.cwd(),
    'node_modules/react-native-camera-kit/ios/ReactNativeCameraKit/RealCamera.swift',
  );
  const label =
    'react-native-camera-kit/ios/ReactNativeCameraKit/RealCamera.swift';

  if (!existsSync(target)) return;

  const MARKER = '// enbox-patch: camera-kit-deferred-start@v1';
  const original = readFileSync(target, 'utf8');

  // Idempotence: already patched.
  if (original.includes(MARKER)) return;

  const originalBlock =
    '    private func applyDeferredStartConfiguration() {\n' +
    '        guard #available(iOS 26.0, *) else { return }\n' +
    '\n' +
    '        let enableDeferredStart = deferredStartEnabled\n' +
    '\n' +
    '        if photoOutput.isDeferredStartSupported {\n' +
    '            photoOutput.isDeferredStartEnabled = enableDeferredStart\n' +
    '        }\n' +
    '\n' +
    '        if metadataOutput.isDeferredStartSupported {\n' +
    '            metadataOutput.isDeferredStartEnabled = enableDeferredStart\n' +
    '        }\n' +
    '    }';

  // Drift guard: if the exact upstream block is missing, leave the file
  // untouched. Workers will catch the resulting build failure and update
  // this patch explicitly rather than risk a half-patched file.
  if (!original.includes(originalBlock)) {
    return;
  }

  const replacementBlock =
    '    ' + MARKER + '\n' +
    '    // iOS 26-only APIs (isDeferredStartSupported / isDeferredStartEnabled)\n' +
    '    // are accessed through KVC so this file compiles against older SDKs\n' +
    '    // (e.g. Xcode 16.4 / SDK 18.5 on the CI runner).\n' +
    '    private func applyDeferredStartConfiguration() {\n' +
    '        guard #available(iOS 26.0, *) else { return }\n' +
    '\n' +
    '        let enableDeferredStart = deferredStartEnabled\n' +
    '\n' +
    '        if (photoOutput.value(forKey: "deferredStartSupported") as? Bool) == true {\n' +
    '            photoOutput.setValue(enableDeferredStart, forKey: "deferredStartEnabled")\n' +
    '        }\n' +
    '\n' +
    '        if (metadataOutput.value(forKey: "deferredStartSupported") as? Bool) == true {\n' +
    '            metadataOutput.setValue(enableDeferredStart, forKey: "deferredStartEnabled")\n' +
    '        }\n' +
    '    }';

  const next = original.replace(originalBlock, replacementBlock);
  if (next !== original) {
    writeFileSync(target, next, 'utf8');
    console.log(`[postinstall] Patched ${label}`);
  }
}

patchReactNativeLevelDb();
patchEnboxAgent();
patchReactNativeCameraKit();
