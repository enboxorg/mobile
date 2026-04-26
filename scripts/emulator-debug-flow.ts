#!/usr/bin/env bun
/**
 * CI emulator driver for the biometric-first onboarding + relaunch flow.
 *
 * This script is executed inside the ``debug-emulator.yml`` workflow after the
 * release APK has been installed and launched. It automates the entire
 * biometric-first onboarding flow end to end using ``adb``:
 *
 *     welcome
 *       -> biometric-setup
 *       -> biometric-prompt-1
 *       -> recovery-phrase
 *       -> main-wallet
 *       -> relaunch-unlock-prompt
 *       -> after-relaunch
 *
 * All waits are bounded (explicit ``timeout`` arguments that throw on expiry)
 * and every stage captures a screenshot using the literal names consumed by
 * the CI validation contract. When any required anchor is missing, the script
 * writes a ``flow-error`` PNG plus a UI dump and exits with a non-zero status
 * so the workflow step fails loudly instead of silently swallowing the
 * regression.
 *
 * The script never types or waits for app-level PIN material. The only digits
 * entered at the OS level are the device lockscreen PIN ``0000`` required to
 * enroll a fingerprint on API 31 (Keystore ``setUserAuthenticationRequired``).
 *
 * This is the TypeScript port of the prior ``emulator-debug-flow.py``. The
 * port preserves the same external behavior (same artifact names, same
 * sanitizer rules, same CLI surface including ``--self-test``) so existing
 * workflow steps and validators do not need to change. Run via:
 *
 *     bun run scripts/emulator-debug-flow.ts
 *     bun run scripts/emulator-debug-flow.ts --self-test
 */

import {spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {wordlist as BIP39_LIST} from '@scure/bip39/wordlists/english';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Frozen 2048-entry BIP-39 English wordlist, used by the sanitizer. */
const BIP39_WORDS: ReadonlySet<string> = new Set(BIP39_LIST);

/**
 * Artifact output root. Both the workflow and validators read PNG/XML files
 * from here, so do not change without coordinating with the CI workflow.
 */
const ROOT = '/tmp/emulator-ui';

const APP_PACKAGE = 'org.enbox.mobile';
const APP_ACTIVITY = `${APP_PACKAGE}/.MainActivity`;

/**
 * Device lockscreen PIN used ONLY for `locksettings set-pin`, which unlocks
 * Keystore enrollment on API 31. This is NOT an app-level credential.
 */
const DEVICE_PIN = '0000';

/**
 * Fingerprint id sent by `adb -e emu finger touch <id>`. Matches the id used
 * throughout the enrollment + unlock flow.
 */
const FINGER_ID = '1';

const WELCOME_ANCHOR = 'Get started';
const BIOMETRIC_SETUP_ANCHOR = 'Enable biometric unlock';
// Curly apostrophe — matches the literal copy on the RecoveryPhrase screen.
const RECOVERY_PHRASE_CONFIRM = 'I\u2019ve saved it';
const MAIN_WALLET_ANCHOR = 'Identities';

const SYSTEM_UI_PACKAGE = 'com.android.systemui';
const BIOMETRIC_PROMPT_PATTERNS: readonly string[] = [
  'Use fingerprint',
  'Use your fingerprint',
  'Touch the fingerprint sensor',
  'Verify it\u2019s you',
  "Verify it's you",
  'fingerprint',
  'Fingerprint',
  'BiometricPrompt',
];

mkdirSync(ROOT, {recursive: true});

// ---------------------------------------------------------------------------
// subprocess + adb plumbing
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  returncode: number;
}

interface RunOpts {
  check?: boolean;
}

function run(cmd: string, args: readonly string[], opts: RunOpts = {}): RunResult {
  const check = opts.check ?? true;
  const result = spawnSync(cmd, args as string[], {
    encoding: 'utf-8',
    // 50 MiB buffer — uiautomator dumps + dumpsys outputs can be large but
    // never approach this limit; lifting it past Node's default (1 MiB)
    // makes the plumbing tolerant of unexpected output sizes.
    maxBuffer: 50 * 1024 * 1024,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  // status is null when the process was killed by a signal; surface that
  // as a non-zero return code so callers can react.
  const returncode = typeof result.status === 'number' ? result.status : -1;
  if (check && returncode !== 0) {
    const err = new Error(
      `Command failed (rc=${returncode}): ${cmd} ${args.join(' ')}\n${stderr}`,
    );
    (err as Error & {stdout: string; stderr: string; returncode: number}).stdout = stdout;
    (err as Error & {stdout: string; stderr: string; returncode: number}).stderr = stderr;
    (err as Error & {stdout: string; stderr: string; returncode: number}).returncode = returncode;
    throw err;
  }
  return {stdout, stderr, returncode};
}

function adb(args: readonly string[], opts: RunOpts = {}): RunResult {
  return run('adb', args, opts);
}

/** Run an `adb -e` command (targets the running emulator). */
function adbEmu(args: readonly string[], opts: RunOpts = {}): RunResult {
  // Default to check=false because emulator console subcommands frequently
  // exit with non-zero on transient HAL races we want to retry, not throw on.
  return run('adb', ['-e', ...args], {check: opts.check ?? false});
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, seconds * 1000));
  });
}

function logInfo(message: string): void {
  process.stdout.write(`${message}\n`);
}

function logErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

// ---------------------------------------------------------------------------
// minimal uiautomator XML parser
// ---------------------------------------------------------------------------
//
// uiautomator dumps are flat trees of ``<node ... />`` (self-closing) and
// ``<node ... > ... </node>`` (with children) elements wrapped in a
// ``<hierarchy>`` root. We never traverse parent/child relationships in this
// driver; every operation is a flat scan over all node elements. A tiny
// regex-based extractor is therefore sufficient and avoids pulling in a
// third-party XML parser as a runtime dependency.
//
// Attribute values in uiautomator dumps are double-quoted. Any literal ``"``
// or ``<``/``>`` inside a value is XML-entity-escaped (``&quot;``, ``&lt;``,
// ``&gt;``), so a ``"[^"]*"`` capture is safe against accidental early
// termination. The BIP-39 sanitizer only inspects ASCII-lowercase 3-8 char
// values, which never contain entity references; the ``recovery phrase``
// title check is a literal substring on the raw value, which would also
// never contain an entity (the screen text is plain ASCII).

interface UiNode {
  attributes: Record<string, string>;
}

const NODE_TAG_REGEX = /<node\b([^>]*?)\/?>/g;
const ATTR_REGEX = /([\w-]+)="([^"]*)"/g;

function parseUiNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const match of xml.matchAll(NODE_TAG_REGEX)) {
    const attrs: Record<string, string> = {};
    const attrsBlock = match[1] ?? '';
    for (const am of attrsBlock.matchAll(ATTR_REGEX)) {
      attrs[am[1]!] = am[2]!;
    }
    nodes.push({attributes: attrs});
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// RecoveryPhrase sanitization
// ---------------------------------------------------------------------------
//
// ``FLAG_SECURE`` protects the RecoveryPhrase screen's PNG screenshot from
// ``adb shell screencap -p`` (see VAL-UX-043) but does NOT stop
// ``uiautomator dump`` from capturing the rendered BIP-39 mnemonic text.
// Uploading the raw XML through ``actions/upload-artifact`` would leak the
// 24-word recovery phrase into the GitHub Actions artifact store.
//
// The sanitizer is **content-aware**, not filename-aware: every XML dump
// (regardless of the name it will eventually be written under) is scanned
// for a RecoveryPhrase indicator. If detected, ALL nodes whose ``text``
// or ``content-desc`` attribute matches the frozen 2048-entry BIP-39
// English wordlist are replaced with the literal string ``[redacted]``.
// Structural nodes (ViewGroup wrappers, the "Back up your recovery
// phrase" title, the "Write these 24 words…" body, word-cell index
// labels like ``"1."``, the ``content-desc="Recovery phrase"`` grid
// wrapper) stay intact so validators can still prove the RecoveryPhrase
// screen was reached and rendered the expected number of cells.
//
// RecoveryPhrase detection (either condition triggers redaction):
//
// 1. Any node ``text`` / ``content-desc`` contains the substring
//    ``recovery phrase`` (case-insensitive) — matches the screen title
//    "Back up your recovery phrase" and the grid wrapper's
//    ``content-desc="Recovery phrase"``.
// 2. Three or more distinct ``<node>`` attributes match the BIP-39
//    wordlist — a conservative clustering threshold that still catches
//    the RecoveryPhrase screen (24 hits) while tolerating a single
//    stray wordlist word ("update", "other", "program", etc.) that
//    might appear on a Settings / wallet / system UI screen without
//    triggering a false positive redaction.
//
// When neither condition fires, the XML is returned byte-for-byte
// unchanged — there is no parse round-trip, no structural difference
// from what uiautomator emitted, and no risk of truncating or reshaping
// unrelated dumps. This makes it safe to route EVERY XML write path
// (named dumps, ``window_dump.xml``, ``flow-error.xml``) through the
// sanitizer: the RecoveryPhrase screen is scrubbed wherever it shows
// up, and every other dump is untouched.

const BIP39_WORD_PATTERN = /^[a-z]{3,8}$/;
const SANITIZED_PLACEHOLDER = '[redacted]';
/**
 * Cluster threshold for the "3+ BIP-39 wordlist hits" indicator. A single
 * stray wordlist hit (e.g. a Settings screen literally showing the verb
 * "update") is tolerated. Three or more hits on one XML is a reliable
 * signal that the RecoveryPhrase cells rendered, which is the leak we're
 * guarding against.
 */
const BIP39_CLUSTER_THRESHOLD = 3;
/**
 * Substring (case-insensitive) whose presence in any node's ``text`` or
 * ``content-desc`` attribute is treated as a positive RecoveryPhrase
 * indicator on its own, regardless of the BIP-39 hit count. Matches the
 * screen title "Back up your recovery phrase" and the grid wrapper's
 * ``content-desc="Recovery phrase"``.
 */
const RECOVERY_PHRASE_TITLE_NEEDLE = 'recovery phrase';

function isBip39Word(value: string): boolean {
  const candidate = value.trim();
  return BIP39_WORD_PATTERN.test(candidate) && BIP39_WORDS.has(candidate);
}

/**
 * Return true when the supplied node set looks like a RecoveryPhrase-bearing
 * dump. See the module-level comment for the indicator rules.
 */
function hasRecoveryPhraseContent(nodes: readonly UiNode[]): boolean {
  let bip39Hits = 0;
  for (const node of nodes) {
    for (const attr of ['text', 'content-desc'] as const) {
      const value = node.attributes[attr];
      if (!value) {
        continue;
      }
      if (value.toLowerCase().includes(RECOVERY_PHRASE_TITLE_NEEDLE)) {
        return true;
      }
      if (isBip39Word(value)) {
        bip39Hits += 1;
        if (bip39Hits >= BIP39_CLUSTER_THRESHOLD) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Return ``xmlText`` with BIP-39 words redacted **iff** the dump contains
 * RecoveryPhrase content. Otherwise return the input string-identical.
 *
 * Mirrors the Python ``_sanitize_bip39_xml`` exactly:
 *
 * - Negative path: byte-for-byte passthrough (no parse round-trip), so
 *   non-RecoveryPhrase screens emerge identical to what uiautomator emitted.
 * - Positive path: in-place attribute replacement for every ``text=`` and
 *   ``content-desc=`` attribute on a ``<node>`` element whose value (after
 *   ``trim()``) is a BIP-39 wordlist entry. All other structure (tree,
 *   bounds, index, resource-id, non-word text like "Back up your recovery
 *   phrase") is preserved.
 */
function sanitizeBip39Xml(xmlText: string): string {
  const nodes = parseUiNodes(xmlText);
  if (!hasRecoveryPhraseContent(nodes)) {
    return xmlText;
  }
  return xmlText.replace(NODE_TAG_REGEX, (fullMatch, attrsBlockRaw: string) => {
    const attrsBlock = attrsBlockRaw ?? '';
    const replaced = attrsBlock.replace(
      /(text|content-desc)="([^"]*)"/g,
      (attrMatch, attrName: string, attrValue: string) => {
        return isBip39Word(attrValue)
          ? `${attrName}="${SANITIZED_PLACEHOLDER}"`
          : attrMatch;
      },
    );
    if (replaced === attrsBlock) {
      return fullMatch;
    }
    // Splice the new attribute block back into the original tag without
    // rebuilding the rest of the tag (preserving spacing, the trailing /,
    // etc.).
    return fullMatch.replace(attrsBlock, replaced);
  });
}

// ---------------------------------------------------------------------------
// UI dump / screenshot helpers
// ---------------------------------------------------------------------------

/**
 * Dump the current UI hierarchy and return the parsed node array.
 *
 * When ``name`` is provided, the XML is also copied to
 * ``/tmp/emulator-ui/<name>.xml`` so downstream validators can read it
 * alongside the matching screenshot.
 *
 * **Content-aware sanitization** is applied to every dump via
 * ``sanitizeBip39Xml`` — regardless of the value of ``name``, including
 * the nameless case where only ``window_dump.xml`` is written.
 */
async function dumpUi(name?: string): Promise<UiNode[]> {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml']);
  const local = join(ROOT, 'window_dump.xml');
  adb(['pull', '/sdcard/window_dump.xml', local]);
  const rawText = readFileSync(local, 'utf-8');
  const sanitized = sanitizeBip39Xml(rawText);
  if (sanitized !== rawText) {
    // Overwrite the working file so the mnemonic cannot leak via
    // ``window_dump.xml`` if the driver crashes before the next dump_ui
    // call overwrites it with a non-RecoveryPhrase hierarchy.
    writeFileSync(local, sanitized, 'utf-8');
  }
  if (name) {
    writeFileSync(join(ROOT, `${name}.xml`), sanitized, 'utf-8');
  }
  return parseUiNodes(sanitized);
}

interface ParsedBounds {
  x: number;
  y: number;
}

const BOUNDS_REGEX = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/;

function parseBounds(bounds: string): ParsedBounds {
  const match = BOUNDS_REGEX.exec(bounds);
  if (!match) {
    throw new Error(`Invalid bounds: ${bounds}`);
  }
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return {
    x: Math.floor((left + right) / 2),
    y: Math.floor((top + bottom) / 2),
  };
}

/**
 * Return the first node whose ``text`` or ``content-desc`` matches ``text``.
 *
 * Falls back to substring matches on ``text`` for robustness against minor
 * UI wording changes.
 */
function findNodeByText(nodes: readonly UiNode[], text: string): UiNode | null {
  for (const node of nodes) {
    if (node.attributes.text === text || node.attributes['content-desc'] === text) {
      return node;
    }
  }
  if (text) {
    for (const node of nodes) {
      const nodeText = node.attributes.text ?? '';
      if (nodeText.includes(text)) {
        return node;
      }
    }
  }
  return null;
}

/**
 * Return the first node whose ``text`` or ``content-desc`` matches ``text``
 * case-insensitively. Used for OS wizard buttons (``MORE``, ``AGREE``,
 * ``DONE`` etc.) which render in uppercase on API 31 AOSP/google_apis.
 */
function findNodeByTextCi(nodes: readonly UiNode[], text: string): UiNode | null {
  const needle = text.toLowerCase();
  for (const node of nodes) {
    const nodeText = (node.attributes.text ?? '').toLowerCase();
    const nodeDesc = (node.attributes['content-desc'] ?? '').toLowerCase();
    if (nodeText === needle || nodeDesc === needle) {
      return node;
    }
  }
  if (needle) {
    for (const node of nodes) {
      const nodeText = (node.attributes.text ?? '').toLowerCase();
      if (nodeText.includes(needle)) {
        return node;
      }
    }
  }
  return null;
}

function findSystemUiBiometricNode(
  nodes: readonly UiNode[],
  patterns: readonly string[] = BIOMETRIC_PROMPT_PATTERNS,
): UiNode | null {
  const patternsLc = patterns.map((p) => p.toLowerCase());
  for (const node of nodes) {
    if (node.attributes.package !== SYSTEM_UI_PACKAGE) {
      continue;
    }
    const haystack = [
      node.attributes.text ?? '',
      node.attributes['content-desc'] ?? '',
      node.attributes.class ?? '',
      node.attributes['resource-id'] ?? '',
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.trim()) {
      continue;
    }
    for (const needle of patternsLc) {
      if (needle && haystack.includes(needle)) {
        return node;
      }
    }
  }
  return null;
}

/**
 * Bounded poll: return the first node matching ``text`` before ``timeout``.
 *
 * Throws on expiry so the top-level error trap captures a flow-error
 * screenshot and the script exits non-zero.
 */
async function waitForText(text: string, timeout = 25.0): Promise<UiNode> {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const nodes = await dumpUi();
    const node = findNodeByText(nodes, text);
    if (node) {
      return node;
    }
    await sleep(1);
  }
  throw new Error(`Text not found within ${timeout.toFixed(0)}s: ${JSON.stringify(text)}`);
}

async function tapText(text: string, timeout = 25.0): Promise<void> {
  const node = await waitForText(text, timeout);
  const {x, y} = parseBounds(node.attributes.bounds!);
  adb(['shell', 'input', 'tap', String(x), String(y)]);
}

/**
 * Return true when ``node`` has non-zero, on-screen bounds. React Native's
 * ScrollView mounts the entire child tree, but nodes that are clipped below
 * the fold render with ``bounds="[0,0][0,0]"`` in the uiautomator dump. A
 * visible tap target must have a positive-extent rectangle that uiautomator
 * can target.
 */
function nodeVisible(node: UiNode): boolean {
  const bounds = node.attributes.bounds ?? '';
  const match = BOUNDS_REGEX.exec(bounds);
  if (!match) {
    return false;
  }
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  return right > left && bottom > top;
}

/**
 * Swipe the foreground ScrollView up until ``text`` is tappable.
 *
 * The RecoveryPhrase screen wraps the hero + 24-word grid + confirm button
 * inside the shared ``Screen`` ``<ScrollView>``. On a Pixel 5 emulator
 * (1080x2340), the word grid and the final "I've saved it" button both
 * land below the initial visible window; uiautomator's dump reports the
 * confirm button at ``[0,0][0,0]`` (or omits it) until the list has been
 * scrolled.
 *
 * Strategy: check the current dump first (handles the case where the button
 * is already visible), then issue bounded-length upward swipes on the
 * content region and re-poll. Throws if the text never becomes visible.
 */
async function scrollIntoView(
  text: string,
  timeout = 45.0,
  maxScrolls = 8,
): Promise<UiNode> {
  const deadline = Date.now() + timeout * 1000;

  const locateVisible = async (): Promise<UiNode | null> => {
    const nodes = await dumpUi();
    const node = findNodeByText(nodes, text);
    return node && nodeVisible(node) ? node : null;
  };

  let node = await locateVisible();
  if (node) {
    return node;
  }

  for (let attempt = 1; attempt <= maxScrolls; attempt += 1) {
    if (Date.now() >= deadline) {
      break;
    }
    // Swipe from the lower-middle of the screen to the upper-middle,
    // emulating a drag to reveal content below the current fold. The
    // 500ms duration avoids being interpreted as a fling (which would
    // overshoot).
    adb(['shell', 'input', 'swipe', '540', '1800', '540', '700', '500']);
    await sleep(0.8);
    node = await locateVisible();
    if (node) {
      logInfo(`[scrollIntoView] ${JSON.stringify(text)} visible after ${attempt} swipe(s)`);
      return node;
    }
  }

  throw new Error(
    `Text not visible after ${maxScrolls} swipe(s) within ${timeout.toFixed(0)}s: ${JSON.stringify(text)}`,
  );
}

function tapNode(node: UiNode): void {
  const {x, y} = parseBounds(node.attributes.bounds!);
  adb(['shell', 'input', 'tap', String(x), String(y)]);
}

function inputText(value: string): void {
  adb(['shell', 'input', 'text', value]);
}

function pressEnter(): void {
  // KEYCODE_ENTER (66) dismisses the lockscreen PIN entry dialog.
  adb(['shell', 'input', 'keyevent', '66']);
}

/**
 * Minimal valid 1x1 opaque PNG (67 bytes). Used as a placeholder when
 * ``adb shell screencap -p`` fails because the foreground surface has
 * ``FLAG_SECURE`` (e.g. the systemui BiometricPrompt dialog on API 31,
 * which SurfaceFlinger refuses to read into the framebuffer for the
 * shell user — emitting ``W SurfaceFlinger: FB is protected:
 * PERMISSION_DENIED`` and exit status 1).
 *
 * The validation contract (VAL-CI-014 + VAL-CI-033) requires each of the
 * seven canonical PNGs to be present and ``file <name>.png`` to report
 * ``PNG image data``; it does NOT require the pixels to depict the
 * underlying secure surface (which is intentionally non-capturable). The
 * corresponding ``window_dump.xml`` captured via ``uiautomator`` — which
 * is not blocked by ``FLAG_SECURE`` — holds the structural content the
 * validators actually cross-check against.
 */
const PLACEHOLDER_PNG_BYTES: Buffer = Buffer.from(
  '89504e470d0a1a0a' + // PNG signature
    '0000000d49484452' + // IHDR length + type
    '00000001000000010806000000' + // 1x1, 8-bit RGBA
    '1f15c4890000000d49444154' + // IDAT length + type
    '789c6300010000000005000100' + // minimal zlib-compressed scanline
    '0dff00020d0000000049454e44' + // IEND length + type
    'ae426082', // IEND CRC
  'hex',
);

function writePlaceholderPng(localPath: string): void {
  writeFileSync(localPath, PLACEHOLDER_PNG_BYTES);
}

/**
 * Names of screens whose captured framebuffer could contain a user-visible
 * BIP-39 mnemonic or other high-sensitivity text. ``screencap`` short-
 * circuits for these screens and ALWAYS writes the placeholder PNG instead
 * of reading the emulator framebuffer, so a FLAG_SECURE regression at the
 * native layer cannot leak the mnemonic into an uploaded CI artifact.
 *
 * Keep the set conservative — we only need the names we actually call
 * ``screencap("<name>")`` with on sensitive screens. At time of writing
 * this is limited to the freshly-generated mnemonic on the
 * ``RecoveryPhraseScreen`` step; the recovery-restore input screen is
 * user-typed and never flows through ``screencap`` with a payload worth
 * redacting.
 */
const SENSITIVE_SCREEN_NAMES: ReadonlySet<string> = new Set(['recovery-phrase']);

/**
 * Pure helper: decide whether the supplied raw uiautomator XML represents
 * a RecoveryPhrase-bearing screen, AND return the sanitized form to
 * persist alongside the screenshot.
 *
 * **Order matters.** The detection MUST run on the RAW input — sanitizing
 * first would replace every BIP-39 wordlist hit with ``[redacted]``,
 * which (a) drops the cluster count to zero and (b) leaves only the
 * "Back up your recovery phrase" title needle as an indicator. A
 * cluster-only RecoveryPhrase dump (Round-3 review Finding 1) — for
 * example a captured XML that dropped the screen title due to
 * accessibility reordering, framework drift, or A/B test copy — would
 * fail the predicate on the sanitized tree and the gate would let
 * ``screencap("flow-error")`` proceed to a real framebuffer capture
 * containing the mnemonic. Detect first, sanitize second.
 *
 * Exposed as a free function so the no-device sanitizer self-test can
 * exercise the gate's exact decision-on-raw + sanitize-on-write
 * sequence without standing up an emulator.
 */
function classifyForegroundDump(rawXml: string): {
  isSensitive: boolean;
  sanitized: string;
} {
  // CRITICAL: parse + detect on the RAW XML, BEFORE sanitization. See
  // the Round-3 Finding-1 note above.
  const isSensitive = hasRecoveryPhraseContent(parseUiNodes(rawXml));
  // Sanitize for persistence regardless. ``sanitizeBip39Xml`` is itself
  // a no-op on dumps that don't contain RecoveryPhrase content, so on
  // negative inputs ``sanitized === rawXml`` (byte-for-byte) and the
  // caller can skip the disk write.
  const sanitized = sanitizeBip39Xml(rawXml);
  return {isSensitive, sanitized};
}

/**
 * Return true if the current foreground UI is a RecoveryPhrase-bearing
 * screen, based on a fresh uiautomator dump.
 *
 * Used by ``screencap`` to gate the framebuffer capture on the actual
 * current foreground content — not just on the caller-supplied ``name``
 * argument. This closes the leak path identified in the Round-2 review
 * (Finding 1): ``screencap("flow-error")`` is invoked by the global
 * failure handler, which has no way of knowing what screen was
 * foregrounded at the moment of failure. If the driver crashes while
 * RecoveryPhraseScreen is up, a content-blind capture would dump the
 * mnemonic into ``flow-error.png`` even though ``"flow-error"`` is not in
 * SENSITIVE_SCREEN_NAMES.
 *
 * The detection reuses the same content rules (``hasRecoveryPhraseContent``)
 * the dumpUi sanitizer uses, so the screencap and the dump-XML side stay
 * in lock-step: if a dump would be redacted, the screenshot is suppressed.
 *
 * **Fail CLOSED on dump failure** (Round-4 Finding 1). The pre-fix code
 * returned ``false`` on any uiautomator / pull / readFileSync error,
 * which let ``screencap()`` proceed to a real framebuffer capture even
 * though the driver had no idea what was foregrounded. The justification
 * given was "SENSITIVE_SCREEN_NAMES protects the named recovery-phrase
 * path", which is true ONLY for the literal ``screencap("recovery-
 * phrase")`` call site. The diagnostic capture path is different:
 * ``dumpFlowError()`` calls ``screencap("flow-error")`` BEFORE
 * ``dumpUi("flow-error")``, so a transient uiautomator failure while
 * RecoveryPhrase was foregrounded — the very moment a top-level handler
 * is most likely to fire — would let ``flow-error.png`` capture the
 * live framebuffer if FLAG_SECURE regressed. Returning ``true`` on the
 * catch path makes ``screencap()`` write the placeholder PNG instead.
 * The cost is occasional placeholder screenshots on emulators with
 * flaky uiautomator — acceptable because (a) those runs were already
 * in trouble and (b) the matching ``<name>.xml`` dump and adb / logcat
 * logs are still captured separately by ``dumpFlowError`` /
 * ``ci-debug-emulator-runner.sh``.
 */
/**
 * Pure helper that pairs a foreground-dump reader callback with the
 * fail-closed classification contract. Split out from
 * ``foregroundIsSensitive`` so the catch-path semantics (Round-4
 * Finding 1) are testable from ``selfTestSanitizer`` without mocking
 * ``adb`` / the filesystem.
 *
 * Contract:
 * - If ``readRawXml()`` returns successfully, the result is the
 *   classifier's verdict on that XML, plus the raw and sanitized
 *   payloads so the caller can persist the sanitized form.
 * - If ``readRawXml()`` throws (uiautomator wedged, ``adb pull``
 *   failed, ``readFileSync`` couldn't open the local mirror), the
 *   helper returns ``isSensitive: true`` with both payloads ``null``.
 *   This is the fail-CLOSED branch — see Round-4 Finding 1.
 */
function classifyForegroundDumpFromReader(readRawXml: () => string): {
  isSensitive: boolean;
  rawXml: string | null;
  sanitizedXml: string | null;
} {
  try {
    const raw = readRawXml();
    const {isSensitive, sanitized} = classifyForegroundDump(raw);
    return {isSensitive, rawXml: raw, sanitizedXml: sanitized};
  } catch {
    // Fail CLOSED. We cannot tell what's foregrounded, so we MUST
    // assume sensitive content is on screen and let `screencap()`
    // write the placeholder PNG. See the docstring on
    // ``foregroundIsSensitive`` for the full rationale (Round-4
    // Finding 1).
    return {isSensitive: true, rawXml: null, sanitizedXml: null};
  }
}

function foregroundIsSensitive(): boolean {
  const local = join(ROOT, 'window_dump.xml');
  const {isSensitive, rawXml, sanitizedXml} = classifyForegroundDumpFromReader(
    () => {
      adb(['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml']);
      adb(['pull', '/sdcard/window_dump.xml', local]);
      return readFileSync(local, 'utf-8');
    },
  );
  // Persist the sanitized form so the on-disk window_dump.xml never
  // carries plaintext mnemonic words even if the driver crashes before
  // the next dumpUi() call overwrites it. Skip the write on the
  // fail-closed branch (rawXml === null) — there is nothing to persist.
  if (rawXml !== null && sanitizedXml !== null && sanitizedXml !== rawXml) {
    writeFileSync(local, sanitizedXml, 'utf-8');
  }
  return isSensitive;
}

/**
 * Capture a screenshot and pull it to ``/tmp/emulator-ui/<name>.png``.
 *
 * When ``adb shell screencap -p`` fails (typically because a FLAG_SECURE
 * window — e.g. the systemui BiometricPrompt dialog — is on top and
 * SurfaceFlinger refuses to read its contents into the framebuffer), we
 * write a minimal valid PNG placeholder so the artifact still exists and
 * passes ``file *.png`` integrity checks. The structural content we
 * actually verify against is captured separately by ``dumpUi`` and lives
 * in the matching ``<name>.xml``.
 *
 * For names in SENSITIVE_SCREEN_NAMES we skip the ``adb screencap`` call
 * entirely and write the placeholder directly. Beyond the name-based skip
 * we also probe the actual foreground UI via ``foregroundIsSensitive``
 * and skip the capture when it indicates a RecoveryPhrase-bearing dump
 * **OR when the probe itself failed**. ``foregroundIsSensitive`` is
 * fail-CLOSED (Round-4 Finding 1): a uiautomator / adb-pull /
 * readFileSync error is reported as "sensitive" rather than "safe",
 * so a transient dump failure while RecoveryPhrase is foregrounded
 * cannot widen the framebuffer-capture path. This closes the
 * failure-handler leak path: ``screencap("flow-error")`` is invoked
 * by the top-level exception handler with NO knowledge of which
 * screen was foregrounded at crash time, and the moment that handler
 * runs is exactly when uiautomator is most likely to be wedged.
 */
function screencap(name: string): void {
  const devicePath = `/sdcard/${name}.png`;
  const localPath = join(ROOT, `${name}.png`);
  if (SENSITIVE_SCREEN_NAMES.has(name)) {
    logInfo(
      `[screencap] ${JSON.stringify(name)}: sensitive-screen name, writing ` +
        'placeholder PNG without invoking adb screencap to guarantee no ' +
        'mnemonic capture regardless of FLAG_SECURE state.',
    );
    writePlaceholderPng(localPath);
    return;
  }
  if (foregroundIsSensitive()) {
    logInfo(
      `[screencap] ${JSON.stringify(name)}: foreground gate flagged ` +
        'sensitive (uiautomator dump matched the BIP-39 / title ' +
        'indicator, OR the dump itself failed and the gate fell ' +
        'through to its fail-closed branch); writing placeholder PNG ' +
        'without invoking adb screencap to prevent a mnemonic leak ' +
        `via ${JSON.stringify(name)}.png.`,
    );
    writePlaceholderPng(localPath);
    return;
  }
  const result = adb(['shell', 'screencap', '-p', devicePath], {check: false});
  if (result.returncode !== 0) {
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    logInfo(
      `[screencap] ${JSON.stringify(name)}: adb screencap failed ` +
        `(rc=${result.returncode}); writing placeholder PNG. adb output: ` +
        `${JSON.stringify(combined.slice(0, 200))}`,
    );
    writePlaceholderPng(localPath);
    return;
  }
  const pull = adb(['pull', devicePath, localPath], {check: false});
  // If pull failed but screencap succeeded, fall back to the placeholder so
  // the artifact still exists; this is a very rare path (usually an adb
  // transport hiccup).
  if (
    pull.returncode !== 0 ||
    !existsSync(localPath) ||
    statSync(localPath).size === 0
  ) {
    logInfo(
      `[screencap] ${JSON.stringify(name)}: adb pull failed ` +
        `(rc=${pull.returncode}); writing placeholder PNG.`,
    );
    writePlaceholderPng(localPath);
  }
}

/**
 * Bounded wait: block until the foreground window belongs to ``packageName``.
 * Throws on expiry.
 */
async function waitUntilPackage(
  packageName: string,
  timeout = 30.0,
  poll = 1.0,
): Promise<void> {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const result = adb(['shell', 'dumpsys', 'window', 'windows'], {check: false});
    if ((result.stdout ?? '').includes(packageName)) {
      return;
    }
    await sleep(poll);
  }
  throw new Error(
    `Package ${JSON.stringify(packageName)} did not reach the foreground within ${timeout.toFixed(0)}s`,
  );
}

// ---------------------------------------------------------------------------
// device credential + fingerprint enrollment
// ---------------------------------------------------------------------------

/**
 * Module-level cache: once we have ANY positive evidence the HAL committed
 * an enrolled fingerprint, the emulator's enrollment state is durable for
 * the rest of the test run. This sidesteps a nasty race on API 31
 * ``google_apis`` where consecutive ``adb shell dumpsys fingerprint`` calls
 * can return different snapshots (one with ``"count":0``, the next with
 * ``"count":N>0``) because ``FingerprintService`` refreshes
 * ``mAuthenticatorIds`` lazily when the HAL finishes committing an
 * enrollment. Without caching, a polling iteration where the first dumpsys
 * reports count=0 and the second reports count>0 leaves the
 * enrollment-detection logic believing nothing ever happened — even though
 * the HAL's durable enrollment is already on disk.
 */
let enrollmentConfirmed = false;

/**
 * Best-effort check: does the device already have a lockscreen PIN?
 *
 * ``locksettings get-disabled`` is NOT a credential probe — it returns
 * ``false`` whenever the keyguard is active, which is the default on stock
 * AVDs (swipe-to-unlock). To actually detect a PIN credential we probe via
 * ``set-pin`` (which reports "already set" when a PIN exists).
 */
function locksettingsPinIsSet(): boolean {
  const probe = adb(['shell', 'locksettings', 'set-pin', DEVICE_PIN], {check: false});
  const combined = `${probe.stdout}\n${probe.stderr}`.toLowerCase();
  if (probe.returncode === 0) {
    return true;
  }
  return (
    combined.includes('already set') ||
    combined.includes('existing') ||
    combined.includes('old password')
  );
}

/**
 * Ensure the device has a lockscreen PIN (idempotent).
 *
 * Strong biometric Keystore keys on API 31 require a device credential
 * before a fingerprint can be enrolled. The helper returns immediately
 * when the emulator already has a credential set, otherwise issues
 * ``adb shell locksettings set-pin 0000`` (with ``--old`` retries on
 * "already set" failures) within the bounded retry budget.
 */
async function ensureDeviceCredential(timeout = 20.0): Promise<void> {
  const deadline = Date.now() + timeout * 1000;
  if (locksettingsPinIsSet()) {
    logInfo(`[ensureDeviceCredential] device PIN already set (pin=${DEVICE_PIN})`);
    return;
  }
  while (Date.now() < deadline) {
    const result = adb(['shell', 'locksettings', 'set-pin', DEVICE_PIN], {check: false});
    if (result.returncode === 0) {
      logInfo('[ensureDeviceCredential] set-pin succeeded');
      return;
    }
    const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (
      combined.includes('already') ||
      combined.includes('existing') ||
      combined.includes('old')
    ) {
      const retry = adb(
        ['shell', 'locksettings', 'set-pin', '--old', DEVICE_PIN, DEVICE_PIN],
        {check: false},
      );
      if (retry.returncode === 0) {
        logInfo('[ensureDeviceCredential] set-pin with --old succeeded');
        return;
      }
    }
    await sleep(1);
  }
  throw new Error(
    `ensureDeviceCredential: failed to set device PIN within ${timeout.toFixed(0)}s`,
  );
}

/**
 * Durable filesystem probe for an enrolled fingerprint.
 *
 * On API 31 ``google_apis`` the AOSP Fingerprint HAL writes committed
 * enrollments to ``/data/vendor_de/<userId>/fpdata/``; once the HAL
 * succeeds, at least one non-zero-sized file appears there and survives
 * process restarts. Returns true as soon as any non-empty directory entry
 * is present.
 */
function hasFingerprintDataOnDisk(): boolean {
  const candidates = ['/data/vendor_de/0/fpdata', '/data/system/users/0/fpdata'];
  for (const path of candidates) {
    const result = adb(['shell', 'ls', '-A', path], {check: false});
    if (result.returncode !== 0) {
      continue;
    }
    for (const line of (result.stdout ?? '').split('\n')) {
      const entry = line.trim();
      if (!entry || entry === '.' || entry === '..') {
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Return true if any ``"count": N>0`` appears inside a ``"prints"`` blob.
 *
 * Uses a forgiving regex that tolerates whitespace and the ``enrollments``
 * JSON sub-object that AOSP sometimes emits alongside ``prints`` on newer
 * system images. We intentionally scope the match to the ``prints`` section
 * so that unrelated ``"count":<n>`` fields don't produce false positives.
 */
function countFieldPositive(fpText: string): boolean {
  const printsRe = /"prints"\s*:\s*\[\s*(\{[^[\]]*\})/g;
  const countRe = /"count"\s*:\s*([0-9]+)/g;
  for (const match of fpText.matchAll(printsRe)) {
    const entryText = match[1] ?? '';
    for (const cm of entryText.matchAll(countRe)) {
      if (Number(cm[1]) > 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Authoritative "fingerprint actually enrolled" signal (sticky cache).
 *
 * Combines four independent probes; any one firing latches the
 * module-level cache flag so subsequent calls short-circuit to true:
 *
 * 1. ``dumpsys fingerprint`` JSON-parsed ``prints[].count > 0``
 *    (with regex-based fallback when the JSON parse fails on truncated
 *    or nested output).
 * 2. ``dumpsys fingerprint`` legacy ``hasEnrollments: true``.
 * 3. ``dumpsys biometric`` ``hasEnrollments: true``.
 * 4. ``logcat`` ``FingerprintHal: Write fingerprint[<slot>] (0x<nz>,0x1)``
 *    or ``Save authenticator id (0x<nz>)`` HAL commit markers.
 * 5. ``/data/vendor_de/0/fpdata`` filesystem presence (durable).
 *
 * Caching is essential because on API 31 ``google_apis`` the HAL's
 * ``FingerprintService`` refresh is lazy: two back-to-back ``dumpsys``
 * calls can return ``count:0`` and ``count:5`` respectively.
 */
function hasEnrollments(): boolean {
  if (enrollmentConfirmed) {
    return true;
  }

  // 1. Dumpsys fingerprint: parse JSON blob for prints[].count > 0.
  const fpDump = adb(['shell', 'dumpsys', 'fingerprint'], {check: false});
  const fpText = fpDump.returncode === 0 ? fpDump.stdout ?? '' : '';
  if (fpText) {
    const printsArrRe = /"prints"\s*:\s*(\[[^\]]*\])/g;
    for (const match of fpText.matchAll(printsArrRe)) {
      try {
        const prints: unknown = JSON.parse(match[1] ?? '[]');
        if (Array.isArray(prints)) {
          for (const entry of prints) {
            if (entry && typeof entry === 'object') {
              const count = Number((entry as Record<string, unknown>).count ?? 0);
              if (Number.isFinite(count) && count > 0) {
                enrollmentConfirmed = true;
                return true;
              }
            }
          }
        }
      } catch {
        // try the next match / fall through to the regex fallback below
      }
    }
    if (countFieldPositive(fpText)) {
      enrollmentConfirmed = true;
      return true;
    }
    if (/hasEnrollments\s*[:=]\s*true/i.test(fpText)) {
      enrollmentConfirmed = true;
      return true;
    }
  }

  // 2. Dumpsys biometric: BiometricService-layer fallback.
  const bioDump = adb(['shell', 'dumpsys', 'biometric'], {check: false});
  if (bioDump.returncode === 0) {
    const bioText = bioDump.stdout ?? '';
    if (/hasEnrollments\s*[:=]\s*true/i.test(bioText)) {
      enrollmentConfirmed = true;
      return true;
    }
  }

  // 3. Logcat HAL markers — strong, deterministic signals emitted at the
  // moment the HAL commits an enrollment to disk. We read from all buffers
  // so logs don't get missed when the main buffer rolls over under heavy
  // runtime logging.
  const logArgs: ReadonlyArray<readonly string[]> = [
    ['logcat', '-d', '-b', 'all', '-s', 'FingerprintHal:D'],
    ['logcat', '-d', '-s', 'FingerprintHal:D'],
  ];
  for (const args of logArgs) {
    const logcat = adb(args, {check: false});
    if (logcat.returncode !== 0) {
      continue;
    }
    for (const line of (logcat.stdout ?? '').split('\n')) {
      if (line.includes('Write fingerprint') && /\(0x[1-9a-fA-F][0-9a-fA-F]*,0x1\)/.test(line)) {
        enrollmentConfirmed = true;
        return true;
      }
      if (line.includes('Save authenticator id') && /\(0x[1-9a-fA-F][0-9a-fA-F]*\)/.test(line)) {
        enrollmentConfirmed = true;
        return true;
      }
    }
    break;
  }

  // 4. Filesystem probe (durable, monotonic once set).
  if (hasFingerprintDataOnDisk()) {
    enrollmentConfirmed = true;
    return true;
  }

  return false;
}

/**
 * Return the HAL's current enrollment-sample ``count`` from ``dumpsys``.
 *
 * On API 31 ``google_apis`` images this is exposed via the JSON blob
 * ``{"prints":[{"id":0,"count":N,...}]}`` embedded in
 * ``dumpsys fingerprint``. Used as a secondary "enrollment progressing"
 * signal so the main loop can distinguish "wizard is actually enrolling"
 * from "wizard stuck on a sub-screen".
 */
function enrollmentSampleCount(): number {
  const result = adb(['shell', 'dumpsys', 'fingerprint'], {check: false});
  if (result.returncode !== 0) {
    return 0;
  }
  const text = result.stdout ?? '';
  for (const match of text.matchAll(/"prints"\s*:\s*(\[[^\]]*\])/g)) {
    try {
      const prints: unknown = JSON.parse(match[1] ?? '[]');
      if (Array.isArray(prints)) {
        let total = 0;
        for (const entry of prints) {
          if (entry && typeof entry === 'object') {
            const c = Number((entry as Record<string, unknown>).count ?? 0);
            if (Number.isFinite(c)) {
              total += c;
            }
          }
        }
        return total;
      }
    } catch {
      // try next match
    }
  }
  return 0;
}

/**
 * Labels that advance through the fingerprint enrollment wizard on API 31
 * AOSP/google_apis images. Order matters: earlier labels (Intro screen)
 * are tried before later ones (Finish screen) so the tap lands on the
 * correct button when multiple are present on-screen.
 *
 * Explicitly exclude "No thanks", "Cancel", "Skip", "Not now" — tapping
 * any of those dismisses the wizard and the enrollment will never
 * complete.
 */
const WIZARD_ADVANCE_LABELS: readonly string[] = [
  'I agree',
  'Acknowledge',
  'I Agree',
  'Agree',
  'Continue',
  'More',
  'Start',
  'Next',
  'Done',
  'Fingerprint added',
];

const ENROLL_FOCUS_CONFIRM = ['confirmlockpassword', 'confirmlockpin', 'confirmlockpattern'];
const ENROLL_FOCUS_INTRO = ['fingerprintenrollintroduction'];
const ENROLL_FOCUS_FIND_SENSOR = ['fingerprintenrollfindsensor'];
const ENROLL_FOCUS_ENROLLING = ['fingerprintenrollenrolling', 'fingerprintenrollsidecar'];
const ENROLL_FOCUS_FINISH = ['fingerprintenrollfinish'];
const ENROLL_FOCUS_SETTINGS_FINGERPRINT = ['biometrics.fingerprint'];

function currentFocus(): string {
  const result = adb(['shell', 'dumpsys', 'window'], {check: false});
  if (result.returncode !== 0) {
    return '';
  }
  for (const line of (result.stdout ?? '').split('\n')) {
    const stripped = line.trim();
    if (stripped.startsWith('mCurrentFocus=') || stripped.startsWith('mFocusedApp=')) {
      return stripped;
    }
  }
  return '';
}

function focusMatches(focus: string, fragments: readonly string[]): boolean {
  const focusLower = focus.toLowerCase();
  return fragments.some((frag) => focusLower.includes(frag));
}

/**
 * Tap the first node whose text matches any of ``labels`` (case-insensitive).
 * Returns the tapped label on success, ``null`` otherwise.
 */
function tapFirstLabel(
  nodes: readonly UiNode[] | null,
  labels: readonly string[],
): string | null {
  if (!nodes) {
    return null;
  }
  for (const label of labels) {
    const node = findNodeByTextCi(nodes, label);
    if (node) {
      try {
        tapNode(node);
        return label;
      } catch (tapExc) {
        logInfo(`[enrollFingerprint] tap '${label}' failed: ${String(tapExc)}`);
        return null;
      }
    }
  }
  return null;
}

/**
 * Enroll a fingerprint on the running emulator (idempotent).
 *
 * The emulator's fingerprint wizard on API 31 ``google_apis`` images drives
 * through several activities that must each be satisfied in order:
 * Introduction → ConfirmLockPassword/Pin → FindSensor → Enrolling → Finish.
 *
 * Critical fix for the persistent stall observed on fa30d4c: our app
 * (``org.enbox.mobile``) is launched BEFORE this script runs, so it sits
 * on top of the task stack. When the FingerprintEnrollEnrolling activity
 * eventually completes, Android resumes the previously-foregrounded app —
 * ours — pulling focus away from Settings while enrollment is only
 * half-done. The fix is to ``am force-stop`` our app at the top of this
 * function and let the launcher (or an ANR'd launcher) be the previous
 * task; the main flow re-launches the app after enrollment.
 *
 * Success is signalled by ``hasEnrollments()`` (BiometricService.
 * hasEnrollments=true), NOT by reaching the FingerprintEnrollFinish
 * activity: that wizard activity can render "Fingerprint added" even
 * when only a single acquisition sample was captured, after which the
 * HAL silently drops the enrollment.
 */
async function enrollFingerprint(timeout = 600.0): Promise<void> {
  // Prevent our app from being the fallback foreground task while the
  // enrollment wizard is running.
  adb(['shell', 'am', 'force-stop', APP_PACKAGE], {check: false});
  await sleep(1.0);
  // Bump the logcat ring buffer so the deterministic FingerprintHal commit
  // marker can't get evicted by ~10 minutes of runtime noise while we're
  // polling. Default main buffer on the AVD is 256 KiB; promote to 16 MiB.
  adb(['logcat', '-G', '16M'], {check: false});
  // Clear any pending ANR dialog before we start touching Settings.
  await dismissAnrIfPresent(3);

  if (hasEnrollments()) {
    logInfo('[enrollFingerprint] BiometricService reports hasEnrollments=true; skipping');
    return;
  }

  logInfo('[enrollFingerprint] launching android.settings.FINGERPRINT_ENROLL');
  adb(['shell', 'am', 'start', '-W', '-a', 'android.settings.FINGERPRINT_ENROLL'], {check: false});
  await sleep(2.0);

  const deadline = Date.now() + timeout * 1000;
  let touches = 0;
  let taps = 0;
  let pins = 0;
  let relaunches = 0;
  let enrollingTouches = 0;
  let lastDiagnostic = 0;
  let stuckAtNonWizardSince: number | null = null;
  let seenEnrollFinish = false;
  let finishSeenAt: number | null = null;

  while (Date.now() < deadline) {
    const enrolled = hasEnrollments();
    const sampleCount = enrollmentSampleCount();
    if (enrolled) {
      logInfo(
        `[enrollFingerprint] BiometricService hasEnrollments=true after ` +
          `${touches} touch(es), ${taps} wizard tap(s), ${pins} pin-confirm(s); ` +
          `samples=${sampleCount} finish_seen=${seenEnrollFinish}`,
      );
      // Best-effort "Done" tap to leave Settings in a clean state.
      try {
        const nodes = await dumpUi();
        tapFirstLabel(nodes, ['Done', 'Finish', 'OK', 'Next']);
      } catch {
        // ignored
      }
      adb(['shell', 'am', 'force-stop', APP_PACKAGE], {check: false});
      await sleep(0.5);
      return;
    }

    // If the wizard reached the Finish screen but the HAL still reports
    // hasEnrollments=false, the enrollment silently failed (too few samples
    // captured / wizard timed out). Re-launch the intent after a brief
    // grace window so we get another pass instead of exiting early on a
    // phantom success signal.
    if (seenEnrollFinish && finishSeenAt !== null) {
      if (Date.now() - finishSeenAt > 5000 && relaunches < 8) {
        logInfo(
          '[enrollFingerprint] wizard reached Finish but HAL still reports ' +
            'hasEnrollments=false; re-launching intent',
        );
        adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'], {check: false});
        await sleep(0.5);
        adb(
          ['shell', 'am', 'start', '-W', '-a', 'android.settings.FINGERPRINT_ENROLL'],
          {check: false},
        );
        relaunches += 1;
        seenEnrollFinish = false;
        finishSeenAt = null;
        await sleep(3.0);
        continue;
      }
    }

    const focus = currentFocus();
    let nodes: UiNode[] | null;
    try {
      nodes = await dumpUi();
    } catch {
      nodes = null;
    }

    let handled = false;

    // 1) Credential confirmation — type the device PIN + ENTER.
    if (focusMatches(focus, ENROLL_FOCUS_CONFIRM)) {
      inputText(DEVICE_PIN);
      await sleep(0.5);
      pressEnter();
      pins += 1;
      logInfo(`[enrollFingerprint] typed device PIN on ConfirmLock* (${pins} total)`);
      await sleep(2.0);
      handled = true;
    }
    // 2) Intro screen usually auto-advances via launchConfirmLock on API 31,
    // but on some images the user has to tap "More" / "Agree" / "Continue"
    // first. Cover both paths.
    else if (focusMatches(focus, ENROLL_FOCUS_INTRO)) {
      const tapped = tapFirstLabel(
        nodes,
        ['I Agree', 'I agree', 'Agree', 'Continue', 'Next', 'More'],
      );
      if (tapped !== null) {
        logInfo(`[enrollFingerprint] tapped '${tapped}' on Introduction`);
        taps += 1;
        await sleep(1.5);
      } else {
        await sleep(1.0);
      }
      // If a "Done" button is present on the Introduction activity, that's
      // the post-enrollment "Fingerprint added" confirmation screen the
      // wizard rendered under the Introduction class on some API 31
      // google_apis images. Treat as success.
      if (nodes) {
        const doneNode = findNodeByTextCi(nodes, 'Done');
        if (doneNode && !findNodeByTextCi(nodes, 'More')) {
          logInfo(
            "[enrollFingerprint] 'Done' visible on Introduction-class " +
              'activity; treating as Finish (pending HAL verify)',
          );
          seenEnrollFinish = true;
          if (finishSeenAt === null) {
            finishSeenAt = Date.now();
          }
        }
      }
      handled = true;
    }
    // 3) "Touch the sensor" screen — on API 31 google_apis the only
    // clickable is "DO IT LATER" (don't tap!). The screen auto-advances to
    // Enrolling when a fingerprint touch arrives.
    else if (focusMatches(focus, ENROLL_FOCUS_FIND_SENSOR)) {
      adbEmu(['emu', 'finger', 'touch', FINGER_ID]);
      touches += 1;
      await sleep(0.8);
      handled = true;
    }
    // 4) Enrollment in progress — fire a burst of touches so the HAL
    // accrues enough samples even when the wizard window is short. On API
    // 31 google_apis the HAL needs ~6-8 acquisition samples before it will
    // commit an enrolled fingerprint.
    else if (focusMatches(focus, ENROLL_FOCUS_ENROLLING)) {
      for (let i = 0; i < 4; i += 1) {
        adbEmu(['emu', 'finger', 'touch', FINGER_ID]);
        touches += 1;
        enrollingTouches += 1;
        await sleep(0.4);
      }
      handled = true;
    }
    // 5) Finish screen — we *think* enrollment succeeded. Mark the flag but
    // do NOT exit; the real exit condition is hasEnrollments() at the top
    // of the loop. The Finish-but-no-enrollment recovery block re-launches
    // the intent after a short grace window.
    else if (focusMatches(focus, ENROLL_FOCUS_FINISH)) {
      if (!seenEnrollFinish) {
        logInfo(
          '[enrollFingerprint] FingerprintEnrollFinish activity focused; ' +
            'waiting on HAL confirmation',
        );
      }
      seenEnrollFinish = true;
      if (finishSeenAt === null) {
        finishSeenAt = Date.now();
      }
      tapFirstLabel(nodes, ['Done', 'Finish', 'OK', 'Next']);
      taps += 1;
      await sleep(1.0);
      handled = true;
    }

    // 6) Something unexpected (Security Settings, Home screen, etc.).
    if (!handled) {
      if (await dismissAnrIfPresent(3)) {
        await sleep(1.0);
        continue;
      }

      // Our app isn't a legit fingerprint-wizard host. If focus has landed
      // on org.enbox.mobile it means the previous Settings activity ended;
      // go HOME and let the re-launch branch pick it up on the next
      // iteration. We never tap our own UI buttons from this path —
      // doing so drives the biometric flow on a half-enrolled HAL.
      if ((focus ?? '').includes(APP_PACKAGE)) {
        adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'], {check: false});
        await sleep(0.5);
        adb(['shell', 'am', 'force-stop', APP_PACKAGE], {check: false});
        await sleep(0.5);
      }

      const stillInWizard = focusMatches(focus, ENROLL_FOCUS_SETTINGS_FINGERPRINT);
      const now = Date.now();
      if (stillInWizard) {
        stuckAtNonWizardSince = null;
      } else {
        if (stuckAtNonWizardSince === null) {
          stuckAtNonWizardSince = now;
        } else if (now - stuckAtNonWizardSince > 10_000 && relaunches < 8) {
          logInfo(
            `[enrollFingerprint] not in wizard (focus=${JSON.stringify(focus)}); ` +
              're-launching FINGERPRINT_ENROLL',
          );
          adb(
            ['shell', 'am', 'start', '-W', '-a', 'android.settings.FINGERPRINT_ENROLL'],
            {check: false},
          );
          relaunches += 1;
          stuckAtNonWizardSince = null;
          await sleep(3.0);
          continue;
        }
      }
      // Fallback: try a text-based wizard advance + finger touch. NEVER tap
      // labels from our own app — the HOME-out above ensures focus belongs
      // to Settings or the launcher.
      let tapped: string | null = null;
      if (focus && !focus.includes(APP_PACKAGE)) {
        tapped = tapFirstLabel(nodes, WIZARD_ADVANCE_LABELS);
      }
      if (tapped !== null) {
        logInfo(`[enrollFingerprint] fallback tapped '${tapped}' (focus=${JSON.stringify(focus)})`);
        taps += 1;
        await sleep(1.0);
      } else {
        adbEmu(['emu', 'finger', 'touch', FINGER_ID]);
        touches += 1;
        await sleep(1.0);
      }
    }

    // Periodic diagnostics so a timeout doesn't hide the root cause.
    const now = Date.now();
    if (now - lastDiagnostic > 15_000) {
      lastDiagnostic = now;
      const dumpsysExcerpt = (
        adb(['shell', 'dumpsys', 'fingerprint'], {check: false}).stdout ?? ''
      )
        .slice(0, 500)
        .replace(/\n/g, ' | ');
      const buttonTexts: string[] = [];
      if (nodes) {
        for (const node of nodes.slice(0, 200)) {
          const t = (node.attributes.text ?? '').trim();
          if (t && node.attributes.clickable === 'true') {
            buttonTexts.push(t);
          }
        }
      }
      logInfo(
        `[enrollFingerprint] touches=${touches} taps=${taps} pins=${pins} ` +
          `relaunches=${relaunches} enrolled=${enrolled} samples=${sampleCount} ` +
          `enrolling_touches=${enrollingTouches} finish_seen=${seenEnrollFinish} ` +
          `focus=${JSON.stringify(focus)} clickable=${JSON.stringify(buttonTexts.slice(0, 10))} ` +
          `dumpsys=${JSON.stringify(dumpsysExcerpt)}`,
      );
    }
  }

  throw new Error(
    `enrollFingerprint: BiometricService.hasEnrollments stayed false for ` +
      `${timeout.toFixed(0)}s (${touches} touch(es), ${taps} tap(s), ` +
      `${pins} pin(s), ${relaunches} re-launch(es))`,
  );
}

// ---------------------------------------------------------------------------
// biometric prompt interaction
// ---------------------------------------------------------------------------

/**
 * Poll the UI dump for a ``com.android.systemui`` biometric prompt node.
 * Returns the matched node. Throws on expiry so the top-level handler
 * captures the flow-error artifacts.
 */
async function waitForBiometricPrompt(timeout = 30.0): Promise<UiNode> {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    let nodes: UiNode[];
    try {
      nodes = await dumpUi();
    } catch {
      await sleep(1);
      continue;
    }
    const node = findSystemUiBiometricNode(nodes);
    if (node) {
      return node;
    }
    await sleep(1);
  }
  throw new Error(
    `waitForBiometricPrompt: no com.android.systemui biometric node within ${timeout.toFixed(0)}s`,
  );
}

/**
 * Fire the emulator fingerprint touch and verify the prompt disappears.
 *
 * Sends ``adb -e emu finger touch 1`` up to a handful of times, re-dumping
 * the UI between touches until no ``com.android.systemui`` biometric node
 * remains. Throws if the overlay is still present after ``timeout`` seconds.
 */
async function satisfyBiometricPrompt(timeout = 20.0): Promise<void> {
  const deadline = Date.now() + timeout * 1000;
  let touches = 0;
  while (Date.now() < deadline) {
    adbEmu(['emu', 'finger', 'touch', FINGER_ID]);
    touches += 1;
    await sleep(1);
    let nodes: UiNode[];
    try {
      nodes = await dumpUi();
    } catch {
      continue;
    }
    const node = findSystemUiBiometricNode(nodes);
    if (!node) {
      logInfo(`[satisfyBiometricPrompt] overlay dismissed after ${touches} touch(es)`);
      return;
    }
  }
  throw new Error(
    `satisfyBiometricPrompt: biometric overlay did not dismiss within ${timeout.toFixed(0)}s`,
  );
}

// ---------------------------------------------------------------------------
// relaunch cycle
// ---------------------------------------------------------------------------

function forceStopApp(): void {
  adb(['shell', 'am', 'force-stop', APP_PACKAGE]);
}

function startApp(): void {
  adb(['shell', 'am', 'start', '-n', APP_ACTIVITY]);
}

interface RelaunchTimeouts {
  promptTimeout?: number;
  satisfyTimeout?: number;
  walletTimeout?: number;
}

/**
 * Force-stop the app, restart it, satisfy the unlock prompt, re-verify the
 * main wallet anchor.
 *
 * Captures ``relaunch-unlock-prompt.png`` on the system-ui BiometricPrompt
 * and ``after-relaunch.png`` after the main wallet anchor reappears. All
 * waits are bounded and throw on expiry.
 */
async function relaunchAndUnlock(opts: RelaunchTimeouts = {}): Promise<void> {
  const {promptTimeout = 45.0, satisfyTimeout = 20.0, walletTimeout = 45.0} = opts;
  forceStopApp();
  await sleep(1);
  startApp();
  await waitUntilPackage(APP_PACKAGE, 30.0);

  await waitForBiometricPrompt(promptTimeout);
  screencap('relaunch-unlock-prompt');
  await dumpUi('relaunch-unlock-prompt');
  await satisfyBiometricPrompt(satisfyTimeout);

  // Give the app a beat to finish rendering the wallet after the unlock.
  await waitForText(MAIN_WALLET_ANCHOR, walletTimeout);
  screencap('after-relaunch');
  await dumpUi('after-relaunch');
}

// ---------------------------------------------------------------------------
// boot + ANR helpers + main flow
// ---------------------------------------------------------------------------

async function waitForBootCompleted(timeout = 90.0, settle = 10.0): Promise<void> {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const result = adb(['shell', 'getprop', 'sys.boot_completed'], {check: false});
    if ((result.stdout ?? '').trim() === '1') {
      break;
    }
    await sleep(1.0);
  }
  if (settle > 0) {
    await sleep(settle);
  }
}

/**
 * If a system ANR dialog ("App isn't responding") is on-screen, tap "Wait"
 * to keep the application running. Returns true when an ANR dialog was
 * observed and dismissed.
 */
async function dismissAnrIfPresent(maxAttempts = 3): Promise<boolean> {
  let dismissedAny = false;
  // The ANR dialog can race with uiautomator dump — uiautomator sometimes
  // captures the underlying launcher hierarchy instead of the overlay,
  // especially right after the dialog pops. Retry up to maxAttempts times.
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let nodes: UiNode[];
    try {
      nodes = await dumpUi();
    } catch {
      await sleep(0.5);
      continue;
    }
    let closePresent = false;
    let waitNode: UiNode | null = null;
    for (const node of nodes) {
      const text = (node.attributes.text ?? '').trim().toLowerCase();
      if (text === 'close app') {
        closePresent = true;
      } else if (text === 'wait') {
        waitNode = node;
      }
    }
    if (!(closePresent && waitNode)) {
      if (dismissedAny) {
        return dismissedAny;
      }
      await sleep(0.5);
      continue;
    }
    try {
      tapNode(waitNode);
      logInfo("[dismissAnr] tapped 'Wait' on ANR dialog");
      dismissedAny = true;
    } catch (tapExc) {
      logInfo(`[dismissAnr] tap 'Wait' failed: ${String(tapExc)}`);
      return dismissedAny;
    }
    await sleep(1.5);
  }
  return dismissedAny;
}

async function mainFlow(): Promise<number> {
  logInfo('== preparing emulator (device credential + fingerprint) ==');
  await waitForBootCompleted();
  // Launcher ANRs sometimes appear right after boot_completed on first run
  // of a fresh AVD; dismiss before touching Settings.
  await dismissAnrIfPresent();
  await ensureDeviceCredential();
  await enrollFingerprint();

  // Reset the app to a known foreground state before we start the flow.
  // The enrollment step may have pushed Settings to the foreground.
  forceStopApp();
  await sleep(1);
  startApp();
  await waitUntilPackage(APP_PACKAGE, 45.0);

  logInfo('== welcome ==');
  await waitForText(WELCOME_ANCHOR, 45.0);
  screencap('welcome');
  await dumpUi('welcome');
  await tapText(WELCOME_ANCHOR, 15.0);

  logInfo('== biometric-setup ==');
  await waitForText(BIOMETRIC_SETUP_ANCHOR, 30.0);
  screencap('biometric-setup');
  await dumpUi('biometric-setup');
  await tapText(BIOMETRIC_SETUP_ANCHOR, 15.0);

  logInfo('== biometric-prompt-1 ==');
  await waitForBiometricPrompt(45.0);
  screencap('biometric-prompt-1');
  await dumpUi('biometric-prompt-1');
  await satisfyBiometricPrompt(30.0);

  logInfo('== recovery-phrase ==');
  // First wait for the RecoveryPhrase screen to mount — any anchor that is
  // always at the top of the screen works.
  await waitForText('Back up your recovery phrase', 45.0);
  screencap('recovery-phrase');
  await dumpUi('recovery-phrase');
  // The 24-word grid pushes the "I've saved it" confirm button below the
  // initial viewport on a standard Pixel 5 emulator; scroll it into view.
  const confirmNode = await scrollIntoView(RECOVERY_PHRASE_CONFIRM, 45.0);
  tapNode(confirmNode);

  logInfo('== main-wallet ==');
  await waitForText(MAIN_WALLET_ANCHOR, 45.0);
  screencap('main-wallet');
  await dumpUi('main-wallet');

  logInfo('== relaunch cycle ==');
  await relaunchAndUnlock();

  logInfo('== verifying wallet anchor (final) ==');
  // Final anchor check: keep this as the last action before return 0 so a
  // regression here causes a non-zero exit (VAL-CI-024).
  await waitForText(MAIN_WALLET_ANCHOR, 30.0);

  logInfo('== flow complete ==');
  return 0;
}

async function dumpFlowError(exc: unknown): Promise<void> {
  try {
    screencap('flow-error');
  } catch (captureExc) {
    logErr(`flow-error screencap failed: ${String(captureExc)}`);
  }
  try {
    await dumpUi('flow-error');
  } catch (dumpExc) {
    logErr(`flow-error UI dump failed: ${String(dumpExc)}`);
  }
  logErr(`FLOW_ERROR: ${String(exc)}`);
}

// ---------------------------------------------------------------------------
// self-test (no device required)
// ---------------------------------------------------------------------------

interface RecoveryPhraseFixtureOpts {
  rootTag?: string;
  includeTitle?: boolean;
  includeGridWrapper?: boolean;
}

/**
 * Build a synthetic RecoveryPhrase uiautomator dump (24-word grid).
 *
 * Factored out so both the direct RecoveryPhrase dump case and the
 * "flow-error.xml while RecoveryPhrase was active" case can share the same
 * cell shape. Every one of the 24 words is a real BIP-39 wordlist entry.
 */
function buildRecoveryPhraseXml(opts: RecoveryPhraseFixtureOpts = {}): string {
  const {rootTag = 'hierarchy', includeTitle = true, includeGridWrapper = true} = opts;
  const sampleWords = [
    'abandon', 'ability', 'able', 'about', 'above', 'absent',
    'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident',
    'account', 'accuse', 'achieve', 'acid', 'acoustic', 'acquire',
    'across', 'act', 'action', 'actor', 'actress', 'actual',
  ];
  if (sampleWords.length !== 24) {
    throw new Error('buildRecoveryPhraseXml: expected exactly 24 sample words');
  }
  const cellsXml = sampleWords
    .map((word, i) => {
      // Structural wrapper cell (no text) followed by an index label cell
      // ("1.") and a word-cell (the real mnemonic word).
      return (
        `<node index="${i * 3 + 0}" text="" resource-id="recovery-phrase-word-${i + 1}" ` +
        `class="android.view.ViewGroup" package="org.enbox.mobile" content-desc="" ` +
        `bounds="[0,0][100,100]" />` +
        `<node index="${i * 3 + 1}" text="${i + 1}." resource-id="" ` +
        `class="android.widget.TextView" package="org.enbox.mobile" content-desc="" ` +
        `bounds="[0,0][20,20]" />` +
        `<node index="${i * 3 + 2}" text="${word}" resource-id="" ` +
        `class="android.widget.TextView" package="org.enbox.mobile" content-desc="" ` +
        `bounds="[0,0][50,50]" />`
      );
    })
    .join('');
  const chrome: string[] = [];
  if (includeTitle) {
    chrome.push(
      '<node index="0" text="Back up your recovery phrase" resource-id="" ' +
        'class="android.view.View" package="org.enbox.mobile" content-desc="" ' +
        'bounds="[0,0][1000,200]" />',
    );
    chrome.push(
      '<node index="1" text="Write these 24 words down in order." resource-id="" ' +
        'class="android.widget.TextView" package="org.enbox.mobile" content-desc="" ' +
        'bounds="[0,0][1000,300]" />',
    );
  }
  if (includeGridWrapper) {
    chrome.push(
      '<node index="2" text="" resource-id="recovery-phrase-word-grid" ' +
        'class="android.view.ViewGroup" package="org.enbox.mobile" ' +
        'content-desc="Recovery phrase" bounds="[0,0][1000,2000]" />',
    );
  }
  const chromeXml = chrome.join('');
  return (
    "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>" +
    `<${rootTag} rotation="0">${chromeXml}${cellsXml}</${rootTag}>`
  );
}

const WELCOME_FIXTURE_XML =
  "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>" +
  '<hierarchy rotation="0">' +
  '<node index="0" text="Welcome to enbox" resource-id="" ' +
  'class="android.view.View" package="org.enbox.mobile" ' +
  'content-desc="" bounds="[0,0][1080,400]" />' +
  '<node index="1" text="Get started" resource-id="" ' +
  'class="android.widget.Button" package="org.enbox.mobile" ' +
  'content-desc="" bounds="[100,1000][900,1200]" />' +
  '<node index="2" text="Restore wallet" resource-id="" ' +
  'class="android.widget.Button" package="org.enbox.mobile" ' +
  'content-desc="" bounds="[100,1300][900,1500]" />' +
  '</hierarchy>';

// "update" is a BIP-39 wordlist entry; a Settings / release-notes / error
// screen can legitimately contain it. With 1 hit and no title match, the
// cluster threshold keeps the dump byte-for-byte.
const STRAY_FIXTURE_XML =
  "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>" +
  '<hierarchy rotation="0">' +
  '<node index="0" text="System update available" resource-id="" ' +
  'class="android.view.View" package="org.enbox.mobile" ' +
  'content-desc="" bounds="[0,0][1080,400]" />' +
  '<node index="1" text="update" resource-id="" ' +
  'class="android.widget.Button" package="org.enbox.mobile" ' +
  'content-desc="" bounds="[100,1000][900,1200]" />' +
  '<node index="2" text="Dismiss" resource-id="" ' +
  'class="android.widget.Button" package="org.enbox.mobile" ' +
  'content-desc="" bounds="[100,1300][900,1500]" />' +
  '</hierarchy>';

/**
 * Exercise ``sanitizeBip39Xml`` against both positive and negative fixtures.
 *
 * Positive cases (MUST redact BIP-39 words, MUST preserve structure):
 *   (a) Direct RecoveryPhrase dump.
 *   (b) flow-error.xml shaped dump captured while RecoveryPhrase active.
 *
 * Negative cases (MUST return the input string-identical):
 *   (c) welcome.xml with no RecoveryPhrase content.
 *   (d) welcome.xml with one stray BIP-39 word ("update").
 *
 * Predicate parity case:
 *   (e) hasRecoveryPhraseContent matches the sanitizer for all four fixtures.
 *
 * Round-3 Finding 1 regression (cluster-only detection ordering):
 *   (f) classifyForegroundDump correctly gates on a RecoveryPhrase dump
 *       whose only positive signal is the >=3-BIP-39-word cluster — i.e.
 *       no "Back up your recovery phrase" title and no
 *       content-desc="Recovery phrase" wrapper. The sanitizer would
 *       (correctly) replace those words with [redacted] in the persisted
 *       form, but the gate decision MUST be made on the RAW XML or the
 *       cluster signal disappears and screencap("flow-error") leaks the
 *       framebuffer. This case directly pins the contract that the gate
 *       runs on raw input.
 *
 * Returns 0 on success, non-zero on failure. Designed to be runnable
 * without any device or emulator.
 */
function selfTestSanitizer(): number {
  const failures: string[] = [];

  // ---------- (a) positive: direct RecoveryPhrase dump ----------
  const rpXml = buildRecoveryPhraseXml();
  const rpSanitized = sanitizeBip39Xml(rpXml);
  if (rpSanitized === rpXml) {
    failures.push(
      'case (a): RecoveryPhrase dump returned byte-for-byte — sanitizer did not run',
    );
  }
  for (const node of parseUiNodes(rpSanitized)) {
    for (const attr of ['text', 'content-desc'] as const) {
      const value = (node.attributes[attr] ?? '').trim();
      if (isBip39Word(value)) {
        failures.push(`case (a): BIP-39 word ${JSON.stringify(value)} leaked through on attr=${JSON.stringify(attr)}`);
      }
    }
  }
  for (const required of [
    'Back up your recovery phrase',
    'Write these 24 words down in order.',
    'content-desc="Recovery phrase"',
    'resource-id="recovery-phrase-word-grid"',
    'resource-id="recovery-phrase-word-1"',
    'resource-id="recovery-phrase-word-24"',
    'text="1."',
    'text="24."',
  ]) {
    if (!rpSanitized.includes(required)) {
      failures.push(`case (a): expected fragment missing after sanitize: ${JSON.stringify(required)}`);
    }
  }
  const rpRedactions = countOccurrences(rpSanitized, SANITIZED_PLACEHOLDER);
  if (rpRedactions < 24) {
    failures.push(`case (a): expected >=24 [redacted] replacements, saw ${rpRedactions}`);
  }

  // ---------- (b) positive: flow-error.xml while RecoveryPhrase active ----
  const flowErrorXml = buildRecoveryPhraseXml();
  const flowErrorSanitized = sanitizeBip39Xml(flowErrorXml);
  if (flowErrorSanitized === flowErrorXml) {
    failures.push(
      'case (b): flow-error-shaped RecoveryPhrase dump returned byte-for-byte — content detection failed',
    );
  }
  for (const node of parseUiNodes(flowErrorSanitized)) {
    for (const attr of ['text', 'content-desc'] as const) {
      const value = (node.attributes[attr] ?? '').trim();
      if (isBip39Word(value)) {
        failures.push(`case (b): BIP-39 word ${JSON.stringify(value)} leaked through on attr=${JSON.stringify(attr)}`);
      }
    }
  }
  const feRedactions = countOccurrences(flowErrorSanitized, SANITIZED_PLACEHOLDER);
  if (feRedactions < 24) {
    failures.push(`case (b): expected >=24 [redacted] replacements, saw ${feRedactions}`);
  }
  for (const required of ['Back up your recovery phrase', 'content-desc="Recovery phrase"']) {
    if (!flowErrorSanitized.includes(required)) {
      failures.push(`case (b): expected fragment missing after sanitize: ${JSON.stringify(required)}`);
    }
  }

  // ---------- (c) negative: welcome.xml with no RecoveryPhrase content ----
  const welcomeSanitized = sanitizeBip39Xml(WELCOME_FIXTURE_XML);
  if (welcomeSanitized !== WELCOME_FIXTURE_XML) {
    failures.push(
      'case (c): clean welcome.xml was modified — expected byte-exact passthrough',
    );
  }

  // ---------- (d) negative: welcome.xml with a single stray BIP-39 word ---
  if (!BIP39_WORDS.has('update')) {
    failures.push("wordlist drift: expected 'update' to be a BIP-39 wordlist entry");
  }
  const straySanitized = sanitizeBip39Xml(STRAY_FIXTURE_XML);
  if (straySanitized !== STRAY_FIXTURE_XML) {
    failures.push(
      'case (d): welcome.xml with 1 stray BIP-39 word was modified — cluster threshold should have kept it byte-exact',
    );
  }

  // ---------- (e) leak-gate predicate parity ----
  if (!hasRecoveryPhraseContent(parseUiNodes(rpXml))) {
    failures.push(
      'case (e): hasRecoveryPhraseContent rejected a real RecoveryPhrase dump — gate would let screencap leak the mnemonic via flow-error.png',
    );
  }
  if (!hasRecoveryPhraseContent(parseUiNodes(flowErrorXml))) {
    failures.push(
      'case (e): hasRecoveryPhraseContent rejected a RecoveryPhrase-bearing flow-error dump — gate would let screencap("flow-error") write a real mnemonic screenshot',
    );
  }
  if (hasRecoveryPhraseContent(parseUiNodes(WELCOME_FIXTURE_XML))) {
    failures.push(
      'case (e): hasRecoveryPhraseContent false-positive on a clean welcome dump — gate would block legitimate screencaps',
    );
  }
  if (hasRecoveryPhraseContent(parseUiNodes(STRAY_FIXTURE_XML))) {
    failures.push(
      'case (e): hasRecoveryPhraseContent false-positive on a stray-wordlist dump — cluster threshold should keep it inert',
    );
  }

  // ---------- (f) Round-3 Finding 1: cluster-only detection ordering ----
  // Build a RecoveryPhrase-shaped dump WITHOUT the "Back up your recovery
  // phrase" title chrome and WITHOUT the content-desc="Recovery phrase"
  // grid wrapper. The only positive signal left is the cluster of 24
  // BIP-39 wordlist hits in the cell labels.
  const clusterOnlyXml = buildRecoveryPhraseXml({
    includeTitle: false,
    includeGridWrapper: false,
  });

  // (f.1) Sanitizer must still redact the cluster — i.e. the predicate
  // is reached on the RAW dump, BIP-39 words become [redacted].
  const clusterOnlySanitized = sanitizeBip39Xml(clusterOnlyXml);
  if (clusterOnlySanitized === clusterOnlyXml) {
    failures.push(
      'case (f.1): cluster-only RecoveryPhrase dump returned byte-for-byte from sanitizer — content detection failed on RAW XML',
    );
  }
  const clusterOnlyRedactions = countOccurrences(
    clusterOnlySanitized,
    SANITIZED_PLACEHOLDER,
  );
  if (clusterOnlyRedactions < 24) {
    failures.push(
      `case (f.1): expected >=24 [redacted] replacements on cluster-only dump, saw ${clusterOnlyRedactions}`,
    );
  }
  for (const node of parseUiNodes(clusterOnlySanitized)) {
    for (const attr of ['text', 'content-desc'] as const) {
      const value = (node.attributes[attr] ?? '').trim();
      if (isBip39Word(value)) {
        failures.push(
          `case (f.1): BIP-39 word ${JSON.stringify(value)} leaked through on attr=${JSON.stringify(attr)}`,
        );
      }
    }
  }

  // (f.2) The pre-fix bug, demonstrated: if the gate is asked on the
  // SANITIZED tree, the cluster signal is gone and the predicate
  // returns false. This is the exact failure mode Finding 1 calls out.
  // The check exists so the suite breaks the moment anyone reorders
  // foregroundIsSensitive() back to "sanitize first, detect second".
  if (hasRecoveryPhraseContent(parseUiNodes(clusterOnlySanitized))) {
    failures.push(
      'case (f.2): wordlist drift — hasRecoveryPhraseContent flagged a sanitized cluster-only dump; the regression demo no longer demonstrates the bug',
    );
  }

  // (f.3) The fix: the gate (run on RAW XML) MUST detect the cluster.
  if (!hasRecoveryPhraseContent(parseUiNodes(clusterOnlyXml))) {
    failures.push(
      'case (f.3): hasRecoveryPhraseContent rejected a cluster-only RecoveryPhrase dump on RAW XML — gate would let screencap("flow-error") leak the mnemonic via the failure-handler path',
    );
  }

  // (f.4) End-to-end: classifyForegroundDump on the RAW input MUST
  // return isSensitive=true AND a sanitized payload that still carries
  // the redactions. This pins the public contract the IO wrapper
  // (foregroundIsSensitive) builds on.
  const clusterOnlyClassified = classifyForegroundDump(clusterOnlyXml);
  if (!clusterOnlyClassified.isSensitive) {
    failures.push(
      'case (f.4): classifyForegroundDump.isSensitive=false on a cluster-only RecoveryPhrase dump — foregroundIsSensitive() would allow framebuffer capture',
    );
  }
  if (clusterOnlyClassified.sanitized === clusterOnlyXml) {
    failures.push(
      'case (f.4): classifyForegroundDump.sanitized was byte-for-byte for a cluster-only RecoveryPhrase dump — sanitizer no-op on a positive case',
    );
  }
  if (
    countOccurrences(clusterOnlyClassified.sanitized, SANITIZED_PLACEHOLDER) <
    24
  ) {
    failures.push(
      'case (f.4): classifyForegroundDump.sanitized lost the [redacted] markers — sanitization regression',
    );
  }

  // (f.5) Negative parity: classifyForegroundDump on a clean welcome
  // dump MUST report isSensitive=false AND return the input
  // byte-for-byte (no spurious sanitization).
  const welcomeClassified = classifyForegroundDump(WELCOME_FIXTURE_XML);
  if (welcomeClassified.isSensitive) {
    failures.push(
      'case (f.5): classifyForegroundDump.isSensitive=true on a clean welcome dump — gate would block legitimate screencaps',
    );
  }
  if (welcomeClassified.sanitized !== WELCOME_FIXTURE_XML) {
    failures.push(
      'case (f.5): classifyForegroundDump.sanitized modified a clean welcome dump — expected byte-exact passthrough',
    );
  }

  // ---------- (g) Round-4 Finding 1: fail-CLOSED on dump-read failure --
  // foregroundIsSensitive() probes the live emulator via
  // adb shell uiautomator dump → adb pull → readFileSync. Any of
  // those three steps can fail transiently (uiautomator wedged after
  // a JNI crash, /sdcard remount race, adb transport hiccup). The
  // pre-fix catch path returned `false` ("assume safe ⇒ allow
  // capture"), which let `screencap("flow-error")` proceed to a real
  // framebuffer capture even when the driver had no idea what was
  // foregrounded — and that path is invoked by `dumpFlowError`
  // EXACTLY when the flow is in trouble (i.e. the same conditions
  // that wedge uiautomator). The fix makes the gate fail CLOSED:
  // when the read throws, the helper reports `isSensitive: true` so
  // `screencap()` writes the placeholder PNG instead. We pin the
  // contract here by exercising the pure helper with synthetic
  // readers — no adb required.
  const failClosedSyntheticReader = () => {
    throw new Error('synthetic uiautomator dump failure (Round-4 F1)');
  };
  const failClosedResult = classifyForegroundDumpFromReader(
    failClosedSyntheticReader,
  );
  if (!failClosedResult.isSensitive) {
    failures.push(
      'case (g.1): fail-CLOSED contract violated — classifyForegroundDumpFromReader returned isSensitive=false on a thrown reader; screencap("flow-error") would proceed to a real framebuffer capture if FLAG_SECURE regressed',
    );
  }
  if (failClosedResult.rawXml !== null) {
    failures.push(
      'case (g.1): fail-CLOSED contract — rawXml MUST be null when the reader threw',
    );
  }
  if (failClosedResult.sanitizedXml !== null) {
    failures.push(
      'case (g.1): fail-CLOSED contract — sanitizedXml MUST be null when the reader threw',
    );
  }

  // (g.2) Positive parity: a successful clean-welcome reader returns
  // isSensitive=false and round-trips raw / sanitized payloads
  // byte-for-byte. This pins that the fail-closed branch is taken
  // ONLY on read failure, never on a clean dump.
  const cleanReaderResult = classifyForegroundDumpFromReader(
    () => WELCOME_FIXTURE_XML,
  );
  if (cleanReaderResult.isSensitive) {
    failures.push(
      'case (g.2): clean welcome reader marked sensitive — gate would block legitimate screencaps',
    );
  }
  if (cleanReaderResult.rawXml !== WELCOME_FIXTURE_XML) {
    failures.push(
      'case (g.2): rawXml mismatch on clean welcome reader — should round-trip byte-for-byte',
    );
  }
  if (cleanReaderResult.sanitizedXml !== WELCOME_FIXTURE_XML) {
    failures.push(
      'case (g.2): sanitizedXml modified on a clean welcome reader — sanitizer should be a no-op on negative inputs',
    );
  }

  // (g.3) Positive parity: an RP-bearing reader (cluster-only,
  // exercising the same hostile fixture as case (f)) returns
  // isSensitive=true and a sanitized payload that drops the BIP-39
  // words. Demonstrates that the IO wrapper produces the same verdict
  // as `classifyForegroundDump` on a successful read — i.e. the
  // fail-closed branch is purely additive coverage on the failure
  // path, not a behavioural regression on the success path.
  const rpReaderResult = classifyForegroundDumpFromReader(
    () => clusterOnlyXml,
  );
  if (!rpReaderResult.isSensitive) {
    failures.push(
      'case (g.3): RP-bearing reader marked safe — gate would let screencap proceed on a real RecoveryPhrase dump',
    );
  }
  if (rpReaderResult.rawXml !== clusterOnlyXml) {
    failures.push(
      'case (g.3): rawXml mismatch on RP-bearing reader — should round-trip byte-for-byte',
    );
  }
  if (rpReaderResult.sanitizedXml === clusterOnlyXml) {
    failures.push(
      'case (g.3): sanitizedXml byte-for-byte on RP-bearing reader — sanitizer regression',
    );
  }
  if (
    rpReaderResult.sanitizedXml === null ||
    countOccurrences(rpReaderResult.sanitizedXml, SANITIZED_PLACEHOLDER) < 24
  ) {
    failures.push(
      'case (g.3): sanitizedXml dropped redaction markers on RP-bearing reader',
    );
  }

  if (failures.length > 0) {
    logErr('== sanitizer self-test FAILED ==');
    for (const line of failures) {
      logErr(`  - ${line}`);
    }
    return 1;
  }
  logInfo('== sanitizer self-test OK ==');
  logInfo(`  (a) RecoveryPhrase: redactions=${rpRedactions} bytes=${Buffer.byteLength(rpSanitized, 'utf-8')}`);
  logInfo(
    `  (b) flow-error.xml while RP active: redactions=${feRedactions} bytes=${Buffer.byteLength(flowErrorSanitized, 'utf-8')}`,
  );
  logInfo(`  (c) welcome.xml (clean): passthrough bytes=${Buffer.byteLength(welcomeSanitized, 'utf-8')}`);
  logInfo(
    `  (d) welcome.xml + 1 stray BIP-39 hit: passthrough bytes=${Buffer.byteLength(straySanitized, 'utf-8')}`,
  );
  logInfo('  (e) hasRecoveryPhraseContent gate matches sanitizer for all 4 fixtures');
  logInfo(
    `  (f) cluster-only RecoveryPhrase dump: gate-on-raw=true, sanitized redactions=${clusterOnlyRedactions} bytes=${Buffer.byteLength(clusterOnlyClassified.sanitized, 'utf-8')}`,
  );
  logInfo(
    '  (g) classifyForegroundDumpFromReader: fail-CLOSED on thrown reader, parity with classifier on successful reads',
  );
  return 0;
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let from = 0;
  while (true) {
    const idx = text.indexOf(needle, from);
    if (idx < 0) {
      break;
    }
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function entryPoint(argv: readonly string[]): Promise<number> {
  if (argv.length > 0 && argv[0] === '--self-test') {
    return selfTestSanitizer();
  }
  try {
    return await mainFlow();
  } catch (exc) {
    await dumpFlowError(exc);
    return 1;
  }
}

// `process.argv[0]` is the runtime (bun / node), `[1]` is the script path,
// `[2]` and beyond are user-supplied CLI args. Match Python's `sys.argv[1:]`.
entryPoint(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    logErr(`FATAL: ${String(err)}`);
    process.exit(1);
  },
);
