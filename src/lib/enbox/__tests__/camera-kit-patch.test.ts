/// <reference types="node" />
/**
 * Contract tests for the react-native-camera-kit deferred-start patch emitted
 * by scripts/apply-patches.mjs.
 *
 * The upstream `RealCamera.swift` uses iOS-26-only properties
 * (`isDeferredStartSupported`, `isDeferredStartEnabled`) that are not present
 * in the CI runner's Xcode 16.4 / SDK 18.5 toolchain, even though a runtime
 * `#available(iOS 26.0, *)` guard wraps them. Our patch rewrites those
 * accesses to go through Key-Value Coding so the file compiles against
 * older SDKs while preserving the iOS-26 runtime behavior.
 *
 * These tests mirror the structure of `enbox-agent-patch.test.ts`:
 *
 *   1. File-content assertions on the patched file — prove the rewrite
 *      dropped the unknown-member references and introduced the KVC-based
 *      shim behind the unique marker.
 *
 *   2. Script behavior assertions — idempotence (repeated invocations leave
 *      the file byte-identical), tolerance of a missing target, and
 *      a `[postinstall] Patched react-native-camera-kit/...` log line on
 *      a fresh pre-patch state with silence on repeat-run.
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
const TARGET = resolve(
  ROOT,
  'node_modules/react-native-camera-kit/ios/ReactNativeCameraKit/RealCamera.swift',
);
const LABEL =
  'react-native-camera-kit/ios/ReactNativeCameraKit/RealCamera.swift';
const MARKER = '// enbox-patch: camera-kit-deferred-start@v1';

const PRE_PATCH_BLOCK =
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

const sha256 = (p: string) =>
  createHash('sha256').update(readFileSync(p)).digest('hex');

const runScript = () =>
  execFileSync('node', [SCRIPT], { cwd: ROOT, stdio: 'pipe' });

const runScriptCapture = (): string =>
  execFileSync('node', [SCRIPT], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

describe('react-native-camera-kit deferred-start patch (filesystem)', () => {
  it('replaces the iOS-26-only property accesses with a KVC shim guarded by the marker', () => {
    const swift = readFileSync(TARGET, 'utf8');

    // Marker is present exactly once (idempotence anchor).
    expect(swift).toContain(MARKER);
    expect(swift.match(new RegExp(MARKER, 'g'))?.length).toBe(1);

    // The original `isDeferredStartSupported` / `isDeferredStartEnabled`
    // dotted property accesses on the outputs must be gone — those are the
    // exact tokens the compiler complained about.
    expect(swift).not.toMatch(/photoOutput\.isDeferredStartSupported/);
    expect(swift).not.toMatch(/photoOutput\.isDeferredStartEnabled/);
    expect(swift).not.toMatch(/metadataOutput\.isDeferredStartSupported/);
    expect(swift).not.toMatch(/metadataOutput\.isDeferredStartEnabled/);

    // KVC-based replacement is in place for both outputs.
    expect(swift).toContain(
      '(photoOutput.value(forKey: "deferredStartSupported") as? Bool) == true',
    );
    expect(swift).toContain(
      'photoOutput.setValue(enableDeferredStart, forKey: "deferredStartEnabled")',
    );
    expect(swift).toContain(
      '(metadataOutput.value(forKey: "deferredStartSupported") as? Bool) == true',
    );
    expect(swift).toContain(
      'metadataOutput.setValue(enableDeferredStart, forKey: "deferredStartEnabled")',
    );

    // The runtime availability guard above the block is preserved.
    expect(swift).toContain('guard #available(iOS 26.0, *) else { return }');
  });
});

describe('react-native-camera-kit deferred-start patch (script behavior)', () => {
  it('is idempotent — repeated invocations leave the file hash unchanged', () => {
    runScript();
    const before = sha256(TARGET);
    runScript();
    const after = sha256(TARGET);
    expect(after).toBe(before);
  });

  it('tolerates a missing target file without throwing', () => {
    const stash = TARGET + '.test-absent';
    const backup = TARGET + '.test-bak';
    copyFileSync(TARGET, backup);
    renameSync(TARGET, stash);
    try {
      expect(existsSync(TARGET)).toBe(false);
      expect(() => runScript()).not.toThrow();
    } finally {
      if (existsSync(stash)) {
        renameSync(stash, TARGET);
      }
      if (!existsSync(TARGET) && existsSync(backup)) {
        copyFileSync(backup, TARGET);
      }
      if (existsSync(backup)) {
        unlinkSync(backup);
      }
      // Ensure the file is fully patched again for downstream tests.
      runScript();
    }
  });

  it('emits a [postinstall] Patched line when the target is in a pre-patch state, and stays silent on the idempotent repeat-run', () => {
    const backup = TARGET + '.test-log-bak';
    copyFileSync(TARGET, backup);
    try {
      // Revert to the upstream pre-patch state: replace the patched block
      // back into the original form and strip the marker line.
      const patched = readFileSync(TARGET, 'utf8');
      const preState = patched
        .replace(new RegExp('    ' + MARKER + '\\r?\\n'), '')
        .replace(
          /    \/\/ iOS 26-only APIs[\s\S]*?\n(    private func applyDeferredStartConfiguration\(\) \{)/,
          '$1',
        )
        .replace(
          /    private func applyDeferredStartConfiguration\(\) \{[\s\S]*?\n    \}/,
          PRE_PATCH_BLOCK,
        );

      expect(preState).toContain('photoOutput.isDeferredStartSupported');
      expect(preState).not.toContain(MARKER);

      writeFileSync(TARGET, preState, 'utf8');

      const firstLog = runScriptCapture();
      expect(firstLog).toContain(`[postinstall] Patched ${LABEL}`);

      // File is now patched — second run must be silent for this target.
      const repeatLog = runScriptCapture();
      expect(repeatLog).not.toMatch(/react-native-camera-kit/);
    } finally {
      copyFileSync(backup, TARGET);
      unlinkSync(backup);
      // Leave the file in a fully-patched state for downstream tests.
      runScript();
    }
  });
});
