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

// ---------------------------------------------------------------------------
// FLAG_SECURE positive assertion (Round-6 Finding 4)
// ---------------------------------------------------------------------------
//
// The pre-Round-6 emulator suite gated mnemonic-bearing screencaps via
// two layers — both of which sit ABOVE the OS-level SurfaceFlinger
// guarantee:
//
//   1. ``SENSITIVE_SCREEN_NAMES`` short-circuits ``screencap()`` to a
//      placeholder PNG for the literal ``"recovery-phrase"`` name.
//   2. ``foregroundIsSensitive()`` probes uiautomator and short-circuits
//      to a placeholder when the dump matches the BIP-39 / title
//      indicator (and fail-closed on dump errors per Round-4 Finding 1).
//
// Both layers prevent the suite ITSELF from leaking the mnemonic. They
// do NOT — and cannot — prove that ``MainActivity`` actually sets the
// ``FLAG_SECURE`` window flag. A regression that removed the
// ``window.setFlags(FLAG_SECURE, FLAG_SECURE)`` call from
// ``MainActivity.onCreate`` (or the per-screen ``FlagSecureModule``
// reference-counting) would slip through the suite green even though
// the actual privacy guarantee is gone — Recents thumbnails, screen-
// mirroring, and accessibility ``ScreenshotProvider`` would all leak the
// mnemonic on a real device.
//
// This module provides a positive assertion: query ``dumpsys window
// windows``, find the org.enbox.mobile window block(s), and verify
// ``FLAG_SECURE`` is present. We call it at the moment the recovery-
// phrase screen is foregrounded, so the assertion exercises the same
// window the user sees during the actual mnemonic display.
//
// ``flagSecureOnFocusedPackageWindow`` is the pure parser (Round-7
// Finding 5: focus-coupled — pre-fix variant returned true for ANY
// org.enbox.mobile window, which let a non-focused background window
// with FLAG_SECURE mask a focused window without it); the IO wrapper
// ``assertFlagSecureOnForeground`` runs ``adb shell dumpsys`` and
// throws on any negative outcome (parser miss, dumpsys failure, no
// foreground window, foreground belongs to another package, focused
// org.enbox.mobile window without FLAG_SECURE). The selfTestSanitizer
// adds ``case (h.1)..(h.10)`` exercising the parser with synthetic
// dumpsys fixtures so a no-device CI run can still gate on parser
// regressions.

interface AdbLike {
  (
    args: readonly string[],
    opts?: RunOpts,
  ): {stdout: string; stderr: string; returncode: number};
}

/**
 * Round-7 Finding 5 + Round-8 Finding 1: extract the focused window
 * descriptor from a dumpsys output. Returns the contents inside
 * ``Window{...}`` (for ``mCurrentFocus`` / ``mFocusedWindow``) or
 * inside ``ActivityRecord{...}`` (for ``mFocusedApp`` / ``mResumedActivity``)
 * — whichever is present first.
 *
 * Round-8 F1 widened the parser surface because Round-7's narrow
 * ``mCurrentFocus`` / ``mFocusedWindow`` regex broke the CI debug
 * workflow on the API-31+ Pixel emulator: ``dumpsys window windows``
 * on those API levels does NOT reliably emit ``mCurrentFocus`` (it
 * was moved into ``dumpsys window`` / ``dumpsys window displays``,
 * see e.g. https://stackoverflow.com/q/59397543). The result was a
 * RecoveryPhrase capture that threw "dumpsys reported NO foreground
 * window" before ``screencap('recovery-phrase')`` /
 * ``dumpUi('recovery-phrase')`` could capture the privacy-gate
 * audit trail — exactly the regression Round-6 F5 was supposed to
 * prevent. The fixes are layered:
 *   (1) the IO wrapper now calls ``dumpsys window`` (no ``windows``
 *       arg) which always emits focus info on every Android version
 *       we care about;
 *   (2) this parser also recognises ``mFocusedApp=`` (an
 *       ActivityRecord, not a Window) so a dump that contains the
 *       activity-level focus marker but lacks the window-level
 *       marker still resolves to a descriptor;
 *   (3) recovery-phrase artifacts are now captured BEFORE the
 *       assertion so a parser regression cannot silently zero out
 *       the audit trail (see ``mainFlow``).
 *
 * Examples of what we parse out:
 *   ``mCurrentFocus=Window{def456 u0 org.enbox.mobile/.MainActivity}``
 *     → ``"def456 u0 org.enbox.mobile/.MainActivity"``
 *   ``mFocusedApp=ActivityRecord{def456 u0 org.enbox.mobile/.MainActivity t12}``
 *     → ``"def456 u0 org.enbox.mobile/.MainActivity t12"``
 *   ``mResumedActivity=ActivityRecord{... org.enbox.mobile/.MainActivity ...}``
 *     → the full descriptor
 *   ``mCurrentFocus=null`` / no marker at all
 *     → ``null``
 *
 * The wrapper {Window,ActivityRecord} type is not part of the
 * returned descriptor — callers only care about whether the
 * package boundary ``<package>/`` appears inside the descriptor and
 * (for FLAG_SECURE search) the matching window block.
 */
function parseFocusedWindowDescriptor(
  dumpsysOutput: string,
): string | null {
  if (!dumpsysOutput) return null;
  // Try focus markers in order of preference. The first match wins.
  // ``mCurrentFocus`` (Window) is the most canonical — it is the
  // exact window that owns input focus. ``mFocusedWindow`` is the
  // older API-level alias for the same concept. ``mFocusedApp`` /
  // ``mResumedActivity`` are activity-level fallbacks that cover the
  // post-API-31 case where the per-window marker has been moved out
  // of ``dumpsys window windows`` — both still uniquely identify the
  // app whose UI is on top, which is sufficient for the privacy-gate
  // assertion.
  const patterns: ReadonlyArray<RegExp> = [
    /mCurrentFocus=Window\{([^}]+)\}/,
    /mFocusedWindow=Window\{([^}]+)\}/,
    /mFocusedApp=ActivityRecord\{([^}]+)\}/,
    /mResumedActivity=ActivityRecord\{([^}]+)\}/,
  ];
  for (const re of patterns) {
    const m = dumpsysOutput.match(re);
    if (!m) continue;
    const desc = (m[1] ?? '').trim();
    if (desc.length > 0) return desc;
  }
  return null;
}

/**
 * Round-7 Finding 5: extract the body lines for a SPECIFIC window
 * descriptor from a dumpsys output. ``descriptor`` is the inside of
 * ``Window{...}`` (e.g. ``"def456 u0 org.enbox.mobile/...MainActivity"``).
 *
 * Returns the body text between this window's header and the next
 * window's header (or end-of-input), suitable for searching for
 * ``FLAG_SECURE``. Returns ``null`` when no block matches.
 */
function extractWindowBlockByDescriptor(
  dumpsysOutput: string,
  descriptor: string,
): string | null {
  if (!dumpsysOutput || !descriptor) return null;
  // Round-8 F1: match by the leading id token, NOT the full
  // descriptor. The four focus-marker variants emit different
  // descriptor shapes:
  //   ``mCurrentFocus=Window{<id> u<n> <pkg>/<cmp>}``
  //   ``mFocusedWindow=Window{<id> u<n> <pkg>/<cmp>}``
  //   ``mFocusedApp=ActivityRecord{<id> u<n> <pkg>/<cmp> t<task>}``
  //     ↑ trailing ``t<taskId>`` is NOT present in the Window{...}
  //     block we want to look up.
  //   ``mResumedActivity=ActivityRecord{<id> u<n> <pkg>/<cmp> t<task>}``
  // The first whitespace-separated token (``<id>``) is a unique
  // handle that appears in BOTH the focus marker and the matching
  // ``Window{<id> ...}`` block, so we anchor on that.
  const id = descriptor.split(/\s+/)[0] ?? '';
  if (!id) return null;
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Anchor on ``Window{<id>`` (no closing brace yet — the rest of
  // the descriptor follows) then greedy-consume until the next
  // ``Window{`` or end of input. The cutoff on ``Window{`` (with
  // the brace) avoids false truncation on attribute lines that
  // happen to start with the bare word "Window".
  const blockRegex = new RegExp(
    `Window\\{${escapedId}[^}]*\\}([\\s\\S]*?)(?=Window\\{|$)`,
  );
  const m = dumpsysOutput.match(blockRegex);
  return m ? (m[1] ?? '') : null;
}

/**
 * Round-7 Finding 5 (focus-aware FLAG_SECURE check): return ``true``
 * iff ``dumpsysOutput`` shows that the FOCUSED window belongs to
 * ``packageName`` AND its attribute block contains ``FLAG_SECURE``.
 *
 * This is a strict tightening of the pre-Round-7 ``flagSecureOnPackageWindow``
 * which returned ``true`` if ANY window of ``packageName`` carried
 * ``FLAG_SECURE`` — including offscreen / non-focused windows. That
 * was a real privacy hole: in multi-window or transient-overlay
 * scenarios, a non-visible app-owned window could carry FLAG_SECURE
 * while the focused window (the one the user actually sees and the
 * Recents thumbnail captures) does not. The pre-Round-7 assertion
 * would pass even though the user-visible window leaks the mnemonic.
 *
 * Returns ``false`` when:
 *   - ``mCurrentFocus`` / ``mFocusedWindow`` is absent or ``null``
 *   - the focused window does not belong to ``packageName``
 *   - the focused window's body does not contain ``FLAG_SECURE``
 *
 * Each of those is a legitimate privacy-gate FAILURE that the IO
 * wrapper below converts into a descriptive error.
 *
 * NOTE: prior to Round-7 the helper was named
 * ``flagSecureOnPackageWindow``. The new name reflects the focus
 * coupling — the old "any window" semantics are no longer available.
 */
function flagSecureOnFocusedPackageWindow(
  dumpsysOutput: string,
  packageName: string,
): boolean {
  if (!dumpsysOutput || !packageName) return false;
  const focusedDescriptor = parseFocusedWindowDescriptor(dumpsysOutput);
  if (!focusedDescriptor) return false;
  // The descriptor format from dumpsys is
  // ``<id> u<userId> <package>/<component>``. Require ``<package>/``
  // to anchor on the package boundary — substring matching alone
  // would incorrectly accept e.g. ``com.example.org.enbox.mobile/...``.
  if (!focusedDescriptor.includes(`${packageName}/`)) return false;
  const block = extractWindowBlockByDescriptor(dumpsysOutput, focusedDescriptor);
  if (block === null) return false;
  return block.includes('FLAG_SECURE');
}

/**
 * IO wrapper: run ``adb shell dumpsys window`` (NOT
 * ``dumpsys window windows`` — see Round-8 F1 below) and assert that
 * the FOCUSED window (per ``mCurrentFocus``) belongs to
 * ``APP_PACKAGE`` and carries ``FLAG_SECURE``. Throw a descriptive
 * ``Error`` on any negative outcome.
 *
 * Round-7 Finding 5 strengthens this from the pre-fix any-window
 * check: we must now correlate the FLAG_SECURE presence with the
 * specific window the user is currently looking at. The pre-fix
 * helper would pass on a multi-window setup where a non-visible
 * org.enbox.mobile window carried FLAG_SECURE while the focused
 * window did not — exactly the regression mode the assertion is
 * supposed to detect.
 *
 * Round-8 Finding 1 fixes a CI-blocking regression introduced by
 * Round-7 F5 itself: on the API-31+ Pixel emulator we use,
 * ``dumpsys window windows`` does not reliably emit any
 * ``mCurrentFocus`` / ``mFocusedWindow`` line — the focus markers
 * were moved into the broader ``dumpsys window`` (no ``windows``
 * arg) and ``dumpsys window displays`` outputs. Both Round-7 CI
 * runs failed at this assertion with "dumpsys reported NO
 * foreground window" BEFORE the recovery-phrase
 * ``screencap`` / ``dumpUi`` calls could capture the privacy-gate
 * audit trail. Three layered fixes:
 *   (1) we now run ``dumpsys window`` (no args) which always emits
 *       focus info on every Android version we target;
 *   (2) ``parseFocusedWindowDescriptor`` accepts ``mFocusedApp`` /
 *       ``mResumedActivity`` as fallbacks so even an oddly-shaped
 *       ``dumpsys window`` (e.g. mid-transition) still resolves;
 *   (3) we retry up to a few times with a short sleep between each
 *       attempt — Android transitions briefly emit
 *       ``mCurrentFocus=null`` while the new window is being
 *       installed, and the dumpsys we capture before the next
 *       frame has settled would otherwise hard-fail.
 * ``mainFlow`` separately captures the recovery-phrase artifacts
 * BEFORE this assertion so even if (1)-(3) collectively still fail,
 * the audit trail is preserved (the placeholder PNG and sanitized
 * XML are written by name, regardless of FLAG_SECURE state).
 *
 * The default ``adbRunner`` is the production ``adb`` binary; the
 * ``adbRunner`` parameter is for the no-device self-test, which feeds
 * synthetic dumpsys fixtures so the parser branches stay covered in
 * CI even without an emulator in scope.
 *
 * ``stabilizeAttempts`` controls how many dumpsys calls we make
 * while waiting for the focus marker to appear. Each retry is
 * separated by ``stabilizeIntervalSeconds``. The default of 6 calls
 * × 0.5s ≈ 3 seconds total wait is enough to cover the typical
 * window-install transition while staying well under a frame budget
 * for the normal happy path (dumpsys returns focus on attempt 1).
 */
async function assertFlagSecureOnForeground(
  context: string,
  adbRunner: AdbLike = adb,
  stabilizeAttempts = 6,
  stabilizeIntervalSeconds = 0.5,
): Promise<void> {
  let lastResult: {
    stdout: string;
    stderr: string;
    returncode: number;
  } | null = null;
  let lastFocusLine = '(mCurrentFocus / mFocusedWindow / mFocusedApp line not found)';
  let lastDescriptor: string | null = null;

  for (let attempt = 0; attempt < Math.max(1, stabilizeAttempts); attempt += 1) {
    // Round-8 F1: ``dumpsys window`` (NOT ``windows``) reliably
    // emits ``mCurrentFocus`` / ``mFocusedApp`` on API 31+ where
    // ``dumpsys window windows`` does not. The output is a superset
    // — it includes the same per-window blocks ``dumpsys window
    // windows`` emits (under the "WINDOW MANAGER WINDOWS" section)
    // PLUS the policy/animator/displays/focus sections that contain
    // the focus markers. ``flagSecureOnFocusedPackageWindow`` works
    // unchanged on the larger output because
    // ``extractWindowBlockByDescriptor`` only needs the ``Window{...}``
    // block for the focused descriptor.
    lastResult = adbRunner(['shell', 'dumpsys', 'window'], {check: false});
    if (lastResult.returncode !== 0) {
      // Don't retry on transport failures — they aren't transient
      // and the operator needs to see the real adb error fast.
      throw new Error(
        `${context}: 'adb shell dumpsys window' failed (rc=${lastResult.returncode}); ` +
          'cannot positively assert FLAG_SECURE on foreground window. ' +
          `stderr: ${JSON.stringify((lastResult.stderr ?? '').slice(0, 200))}`,
      );
    }
    const out = lastResult.stdout ?? '';

    // Surface focus-line details on every failure so the operator
    // can tell *why* the assertion failed: missing focus, focus on a
    // different package, or focus on our package but no FLAG_SECURE.
    // We probe four field names because they appear in different
    // places across Android versions (see
    // ``parseFocusedWindowDescriptor``).
    lastFocusLine =
      out
        .split('\n')
        .find(
          (l) =>
            l.includes('mCurrentFocus=') ||
            l.includes('mFocusedWindow=') ||
            l.includes('mFocusedApp=') ||
            l.includes('mResumedActivity='),
        ) ?? lastFocusLine;
    lastDescriptor = parseFocusedWindowDescriptor(out);

    // Happy path: focus is on our package — break out of the
    // stabilize loop and proceed to the FLAG_SECURE check.
    if (lastDescriptor && lastDescriptor.includes(`${APP_PACKAGE}/`)) {
      break;
    }

    // Soft retry: focus may be transiently null (between
    // ``onPause`` and the new window's ``onResume``) or on another
    // package (e.g. systemui briefly during a navigation
    // transition). We do NOT short-circuit on "focus on different
    // package" because the post-fix happy path may genuinely
    // observe systemui mid-transition for a frame or two; we only
    // commit to that diagnosis after exhausting the retry budget.
    if (attempt + 1 < stabilizeAttempts) {
      await sleep(stabilizeIntervalSeconds);
    }
  }

  const out = lastResult?.stdout ?? '';
  const focusLine = lastFocusLine;
  const focusedDescriptor = lastDescriptor;

  if (!focusedDescriptor) {
    throw new Error(
      `${context}: dumpsys reported NO foreground window after ${stabilizeAttempts} attempts ` +
        `(every ${stabilizeIntervalSeconds}s) — neither mCurrentFocus, mFocusedWindow, mFocusedApp, ` +
        'nor mResumedActivity yielded a parseable descriptor. Cannot positively assert ' +
        'FLAG_SECURE on the recovery-phrase window. Focus line: ' +
        JSON.stringify(focusLine.trim()),
    );
  }
  if (!focusedDescriptor.includes(`${APP_PACKAGE}/`)) {
    throw new Error(
      `${context}: foreground window does not belong to ${APP_PACKAGE} ` +
        `(focus is on ${JSON.stringify(focusedDescriptor)}). The recovery-phrase ` +
        'screen is not actually visible — assertion cannot vouch for the OS-level ' +
        'FLAG_SECURE protection on the user-visible window. Focus line: ' +
        JSON.stringify(focusLine.trim()),
    );
  }
  if (!flagSecureOnFocusedPackageWindow(out, APP_PACKAGE)) {
    throw new Error(
      `${context}: focused ${APP_PACKAGE} window does NOT carry FLAG_SECURE — ` +
        'OS-level mnemonic-capture protection has regressed. The emulator suite ' +
        'still produced a placeholder PNG via the higher-level gates, but ' +
        'Recents thumbnails / screen-mirroring / accessibility capture vectors ' +
        'would leak the mnemonic on a real device. Inspect ' +
        '`MainActivity.onCreate` (window.setFlags(FLAG_SECURE, FLAG_SECURE)) and ' +
        'the FlagSecureModule reference counting. Note that this assertion is ' +
        'now FOCUS-AWARE (Round-7 Finding 5): a non-focused org.enbox.mobile ' +
        'window with FLAG_SECURE no longer satisfies the gate. Focus line: ' +
        JSON.stringify(focusLine.trim()),
    );
  }
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

// ENROLL_FOCUS_CREDENTIAL covers BOTH the ConfirmLock* family (re-
// authenticate an existing screen lock) AND the ChooseLock* family
// (set a brand-new screen lock from inside the FINGERPRINT_ENROLL
// flow). Round-9 F1: on some API 31 ``google_apis`` images the
// FINGERPRINT_ENROLL intent ignores the ``locksettings set-pin``
// path applied by ``ensureDeviceCredential()`` and instead routes
// through ChooseLockPassword (set new PIN → "Re-enter your PIN" →
// confirm). The pre-fix matcher only recognized the Confirm*
// variants, so the wizard's PIN-entry screen fell through to the
// "unhandled" branch, the loop kept relaunching the intent (which
// just bounced back to ChooseLockPassword), exhausted the
// 8-relaunch budget, and then span the finger-touch / wizard-tap
// fallback for the remaining ~9 minutes until the 600 s timeout.
// The same ``inputText(DEVICE_PIN) + pressEnter()`` body advances
// both Confirm and Choose flows (each ChooseLockPassword screen
// has a focused ``password_entry`` that consumes IME input), so
// merging the two sets is safe.
const ENROLL_FOCUS_CREDENTIAL = [
  'confirmlockpassword', 'confirmlockpin', 'confirmlockpattern',
  'chooselockpassword', 'chooselockpin', 'chooselockpattern',
  'chooselockgeneric',
];
// Back-compat alias for any future caller / external test that
// imports the old name. Kept ``readonly`` so an accidental write
// fails type-check.
const ENROLL_FOCUS_CONFIRM: readonly string[] = ENROLL_FOCUS_CREDENTIAL;
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

    // 1) Credential entry — type the device PIN + ENTER.
    //    Round-9 F1: this branch now ALSO handles the ChooseLock*
    //    family (set new screen lock + "Re-enter your PIN"
    //    confirmation) in addition to the original ConfirmLock*
    //    family. Both surfaces share the same focused
    //    ``password_entry`` EditText that consumes IME input, so the
    //    same body advances both flows. After PIN+ENTER the wizard
    //    moves to either FingerprintEnrollIntroduction (Confirm
    //    path) or another ChooseLock screen (Choose path, e.g.
    //    "Re-enter your PIN" → "Confirm your PIN"); either way the
    //    next loop iteration picks it up.
    if (focusMatches(focus, ENROLL_FOCUS_CREDENTIAL)) {
      inputText(DEVICE_PIN);
      await sleep(0.5);
      pressEnter();
      pins += 1;
      logInfo(
        `[enrollFingerprint] typed device PIN on credential screen ` +
          `(${pins} total, focus=${JSON.stringify(focus)})`,
      );
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
        } else if (
          relaunches >= 8 &&
          now - stuckAtNonWizardSince > 60_000
        ) {
          // Round-9 F1: hard-bail when the relaunch budget is
          // exhausted AND we have been stuck on a non-wizard
          // surface for >1 min. The pre-fix code kept tapping
          // wizard-advance labels / sending finger touches for the
          // remaining ~9 min until the 600 s timeout, masking the
          // true root cause (the wizard had abandoned us back to a
          // non-Settings surface, e.g. Launcher / ChooseLock loop)
          // behind a generic ``hasEnrollments stayed false``
          // message. Failing fast surfaces the actual focus +
          // dumpsys excerpt to the operator within ~1 min instead
          // of ~10 min and frees the rest of the CI budget for
          // real diagnostics.
          const dumpsysExcerpt = (
            adb(['shell', 'dumpsys', 'fingerprint'], {check: false}).stdout ?? ''
          )
            .slice(0, 500)
            .replace(/\n/g, ' | ');
          throw new Error(
            `enrollFingerprint: relaunch budget exhausted (relaunches=${relaunches}) ` +
              `and stuck on a non-wizard surface for ` +
              `${((now - stuckAtNonWizardSince) / 1000).toFixed(0)}s ` +
              `(focus=${JSON.stringify(focus)}); ` +
              `samples=${sampleCount} touches=${touches} taps=${taps} pins=${pins} ` +
              `enrolling_touches=${enrollingTouches} finish_seen=${seenEnrollFinish} ` +
              `dumpsys_excerpt=${JSON.stringify(dumpsysExcerpt)}`,
          );
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
  // Round-8 Finding 1: capture artifacts BEFORE the FLAG_SECURE
  // assertion, not after. Round-7 F5 ordered them
  // assert→screencap→dumpUi, which meant a parser regression
  // (Round-7 F5 itself caused one — see
  // ``parseFocusedWindowDescriptor`` — by missing the API-31+
  // ``dumpsys`` shape) zeroed the privacy-gate audit trail BEFORE
  // the placeholder PNG and sanitized XML had a chance to land on
  // disk. Both ``screencap('recovery-phrase')`` and
  // ``dumpUi('recovery-phrase')`` are SAFE to run unconditionally
  // here:
  //   * ``screencap`` short-circuits via SENSITIVE_SCREEN_NAMES and
  //     writes a 96-byte placeholder PNG (no framebuffer read,
  //     therefore no mnemonic leak even if FLAG_SECURE is OFF — the
  //     placeholder is the audit trail).
  //   * ``dumpUi`` runs the BIP-39 / title-redaction sanitizer
  //     before any bytes leave the device, so the resulting XML
  //     never contains a mnemonic word.
  // After they land, ``assertFlagSecureOnForeground`` runs as the
  // OS-level positive gate (Round-6 F4): a regression that removed
  // ``window.setFlags(FLAG_SECURE, FLAG_SECURE)`` from MainActivity
  // would still leak the mnemonic via Recents thumbnails /
  // screen-mirroring / accessibility ScreenshotProvider on a real
  // device, so the assertion still hard-fails the run on FLAG_SECURE
  // regression — but it does so with the audit trail intact.
  screencap('recovery-phrase');
  await dumpUi('recovery-phrase');
  await assertFlagSecureOnForeground('recovery-phrase');
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
async function selfTestSanitizer(): Promise<number> {
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

  // ---------- (h) Round-6 F4 / Round-7 F5: FOCUS-AWARE FLAG_SECURE ----
  // ``assertFlagSecureOnForeground`` runs at the moment the recovery-
  // phrase screen is foregrounded and asserts that the OS-level
  // ``FLAG_SECURE`` flag is set on the FOCUSED window of our package.
  // A regression that removed the flag (e.g. ``MainActivity.onCreate``
  // no longer calling ``window.setFlags``, or ``FlagSecureModule``
  // losing its baseline-preserving refcount) would slip through the
  // higher-level placeholder gates because the emulator driver still
  // won't capture the mnemonic — but the OS-level guarantee on
  // Recents thumbnails / screen-mirroring / accessibility
  // ScreenshotProvider would be gone.
  //
  // Round-7 Finding 5 tightened the assertion: we must positively
  // correlate FLAG_SECURE with the FOCUSED window. The pre-Round-7
  // ``flagSecureOnPackageWindow`` returned ``true`` on ANY app-owned
  // window — so a non-focused (offscreen / background) app window
  // with FLAG_SECURE would mask a focused window without it. The
  // focus-aware variant ``flagSecureOnFocusedPackageWindow`` correlates
  // ``mCurrentFocus`` / ``mFocusedWindow`` with the matching window
  // block.
  //
  // Fixtures mirror the real ``dumpsys window windows`` output as
  // emitted on Android API 31 (the version the emulator suite targets):
  // a per-window block with a ``Window{<id> u<userId> <component>}``
  // header and a multi-line body that includes a ``mAttrs={... flags=
  // FLAG_SECURE FLAG_SHOW_WHEN_LOCKED ...}`` fragment when the secure
  // flag is set.
  const dumpsysWithFlag =
    'Window #0 Window{abc123 u0 com.android.systemui/.StatusBar}:\n' +
    '  mAttrs={(0,0)(fillxfill) sim={adjust=resize} ty=STATUS_BAR ' +
    'flags=FLAG_LAYOUT_NO_LIMITS FLAG_LAYOUT_INSET_DECOR}\n' +
    '\n' +
    'Window #1 Window{def456 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}:\n' +
    '  mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION ' +
    'flags=FLAG_SECURE FLAG_SHOW_WHEN_LOCKED}\n' +
    '  mViewVisibility=0x0 mHaveFrame=true\n' +
    'mCurrentFocus=Window{def456 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}\n' +
    'mFocusedWindow=Window{def456 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}\n';
  const dumpsysWithoutFlag =
    'Window #0 Window{abc123 u0 com.android.systemui/.StatusBar}:\n' +
    '  mAttrs={(0,0)(fillxfill) sim={adjust=resize} ty=STATUS_BAR ' +
    'flags=FLAG_LAYOUT_NO_LIMITS FLAG_LAYOUT_INSET_DECOR}\n' +
    '\n' +
    'Window #1 Window{def456 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}:\n' +
    '  mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION ' +
    'flags=FLAG_SHOW_WHEN_LOCKED FLAG_HARDWARE_ACCELERATED}\n' +
    '  mViewVisibility=0x0 mHaveFrame=true\n' +
    'mCurrentFocus=Window{def456 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}\n';
  const dumpsysWithoutOurPackage =
    'Window #0 Window{abc123 u0 com.android.systemui/.StatusBar}:\n' +
    '  mAttrs={(0,0)(fillxfill) sim={adjust=resize} ty=STATUS_BAR ' +
    'flags=FLAG_LAYOUT_NO_LIMITS FLAG_LAYOUT_INSET_DECOR}\n' +
    '\n' +
    'Window #1 Window{def456 u0 com.example.other/com.example.other.MainActivity}:\n' +
    '  mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION ' +
    'flags=FLAG_SECURE}\n' +
    'mCurrentFocus=Window{def456 u0 com.example.other/com.example.other.MainActivity}\n';
  // Round-7 F5 fixture: app has TWO windows. The non-focused
  // background window has FLAG_SECURE set; the focused user-visible
  // window does NOT. The pre-Round-7 helper would PASS on this
  // input — a real privacy hole — so we exercise it explicitly to
  // pin the focus coupling.
  const dumpsysFocusOnInsecureAppWindow =
    'Window #0 Window{aaa111 u0 org.enbox.mobile/org.enbox.mobile.BackgroundService}:\n' +
    '  mAttrs={(0,0)(fillxfill) ty=APPLICATION ' +
    'flags=FLAG_SECURE FLAG_NOT_FOCUSABLE}\n' +
    '\n' +
    'Window #1 Window{bbb222 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}:\n' +
    '  mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION ' +
    'flags=FLAG_SHOW_WHEN_LOCKED FLAG_HARDWARE_ACCELERATED}\n' +
    '  mViewVisibility=0x0 mHaveFrame=true\n' +
    'mCurrentFocus=Window{bbb222 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}\n';
  // Round-7 F5 fixture: focus is on a SYSTEM (com.android.systemui)
  // window — e.g. the BiometricPrompt overlay. Our app has a window
  // with FLAG_SECURE behind it. The focus-aware helper must still
  // reject this — the user-visible content is the system overlay,
  // not our window.
  const dumpsysFocusOnSystemWindow =
    'Window #0 Window{ccc333 u0 com.android.systemui/.BiometricDialog}:\n' +
    '  mAttrs={(0,0)(fillxfill) ty=SYSTEM_DIALOG ' +
    'flags=FLAG_DIM_BEHIND}\n' +
    '\n' +
    'Window #1 Window{ddd444 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}:\n' +
    '  mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION ' +
    'flags=FLAG_SECURE FLAG_SHOW_WHEN_LOCKED}\n' +
    'mCurrentFocus=Window{ccc333 u0 com.android.systemui/.BiometricDialog}\n';
  // Round-7 F5 fixture: ``mCurrentFocus=null`` — no window currently
  // has focus. The helper must reject; it cannot vouch for an
  // OS-level guarantee on a non-existent window.
  const dumpsysFocusNull =
    'Window #0 Window{abc123 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}:\n' +
    '  mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION flags=FLAG_SECURE}\n' +
    'mCurrentFocus=null\n';
  // Round-7 F5 fixture: older API-level dumpsys variant that emits
  // ONLY ``mFocusedWindow=`` (no ``mCurrentFocus=`` line). The
  // parser must accept both names so the assertion still works on
  // older API levels.
  const dumpsysOnlyFocusedWindow =
    'Window #0 Window{abc123 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}:\n' +
    '  mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION flags=FLAG_SECURE}\n' +
    'mFocusedWindow=Window{abc123 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}\n';
  // Round-8 F1 fixture: API-31+ ``dumpsys window`` shape where the
  // window-level focus marker has been moved out of
  // ``dumpsys window windows`` but the activity-level
  // ``mFocusedApp=`` is still emitted. The parser must accept this
  // as a valid focused-app indicator. The Window block is still
  // present (it's emitted by every "dumpsys window" run) so the
  // FLAG_SECURE block lookup still works.
  const dumpsysOnlyFocusedApp =
    'Window #0 Window{eee555 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}:\n' +
    '  mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION flags=FLAG_SECURE}\n' +
    'mFocusedApp=ActivityRecord{eee555 u0 org.enbox.mobile/org.enbox.mobile.MainActivity t12}\n';
  // Round-8 F1 fixture: ``mResumedActivity=`` as a final fallback
  // (emitted by ``dumpsys activity activities`` and sometimes by
  // ``dumpsys window`` on certain OEM builds). Parser must accept it
  // so the assertion remains usable on devices where the other three
  // markers are absent or empty.
  const dumpsysOnlyResumedActivity =
    'Window #0 Window{fff666 u0 org.enbox.mobile/org.enbox.mobile.MainActivity}:\n' +
    '  mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION flags=FLAG_SECURE}\n' +
    'mResumedActivity=ActivityRecord{fff666 u0 org.enbox.mobile/org.enbox.mobile.MainActivity t12}\n';

  // (h.1) Positive case: org.enbox.mobile FOCUSED window with FLAG_SECURE.
  if (!flagSecureOnFocusedPackageWindow(dumpsysWithFlag, APP_PACKAGE)) {
    failures.push(
      'case (h.1): false negative — flagSecureOnFocusedPackageWindow returned false on a clean dumpsys with FLAG_SECURE set on the focused org.enbox.mobile window',
    );
  }
  // (h.2) Negative case: org.enbox.mobile focused, FLAG_SECURE absent.
  if (flagSecureOnFocusedPackageWindow(dumpsysWithoutFlag, APP_PACKAGE)) {
    failures.push(
      'case (h.2): false positive — flagSecureOnFocusedPackageWindow returned true on a dumpsys whose focused org.enbox.mobile window does NOT carry FLAG_SECURE; the assertion would not fail an actual MainActivity FLAG_SECURE regression',
    );
  }
  // (h.3) Negative case: focus is on a different package (no
  // org.enbox.mobile in dumpsys). The parser must NOT treat any
  // package's FLAG_SECURE as our package's.
  if (flagSecureOnFocusedPackageWindow(dumpsysWithoutOurPackage, APP_PACKAGE)) {
    failures.push(
      'case (h.3): false positive — flagSecureOnFocusedPackageWindow returned true on a dumpsys where focus is on another package',
    );
  }
  // (h.4) IO wrapper: dumpsys returning rc!=0 must throw — fail-loud
  // posture so a transient adb failure cannot silently bypass the
  // privacy gate. Use a synthetic ``adbRunner`` so this branch is
  // exercised without standing up an emulator.
  let h4Threw = false;
  try {
    await assertFlagSecureOnForeground(
      'selftest',
      () => ({
        stdout: '',
        stderr: 'dumpsys not available',
        returncode: 1,
      }),
      1,
      0,
    );
  } catch {
    h4Threw = true;
  }
  if (!h4Threw) {
    failures.push(
      'case (h.4): assertFlagSecureOnForeground did not throw when dumpsys returned a non-zero exit — privacy-gate assertion would silently pass on adb transport hiccups',
    );
  }
  // (h.5) IO wrapper: dumpsys output that lacks FLAG_SECURE on the
  // focused org.enbox.mobile window must throw with a descriptive
  // message that includes the package name. Primary regression branch.
  let h5Threw = false;
  let h5Msg = '';
  try {
    await assertFlagSecureOnForeground(
      'selftest',
      () => ({
        stdout: dumpsysWithoutFlag,
        stderr: '',
        returncode: 0,
      }),
      1,
      0,
    );
  } catch (e) {
    h5Threw = true;
    h5Msg = (e as Error).message;
  }
  if (!h5Threw) {
    failures.push(
      'case (h.5): assertFlagSecureOnForeground did not throw when focused org.enbox.mobile window lacked FLAG_SECURE — primary regression branch is dead',
    );
  } else if (!h5Msg.includes(APP_PACKAGE) || !h5Msg.includes('FLAG_SECURE')) {
    failures.push(
      `case (h.5): assertFlagSecureOnForeground error message missing diagnostic content — got ${JSON.stringify(h5Msg.slice(0, 120))}`,
    );
  }
  // (h.6) IO wrapper: clean dumpsys with focused FLAG_SECURE window
  // must NOT throw — the fast path that lets a healthy run continue.
  let h6Threw = false;
  try {
    await assertFlagSecureOnForeground(
      'selftest',
      () => ({
        stdout: dumpsysWithFlag,
        stderr: '',
        returncode: 0,
      }),
      1,
      0,
    );
  } catch {
    h6Threw = true;
  }
  if (h6Threw) {
    failures.push(
      'case (h.6): assertFlagSecureOnForeground threw on a healthy dumpsys with FLAG_SECURE present on the focused window — false positive would block every emulator run',
    );
  }
  // (h.7) Round-7 F5 PRIMARY regression: focus is on an INSECURE
  // org.enbox.mobile window while a different (background)
  // org.enbox.mobile window has FLAG_SECURE. The pre-Round-7
  // ``any-window`` helper would PASS this — a privacy hole — so
  // we positively assert the focus-aware variant rejects it.
  if (
    flagSecureOnFocusedPackageWindow(
      dumpsysFocusOnInsecureAppWindow,
      APP_PACKAGE,
    )
  ) {
    failures.push(
      'case (h.7): false positive — flagSecureOnFocusedPackageWindow returned true when focus was on an INSECURE org.enbox.mobile window despite a non-focused org.enbox.mobile window carrying FLAG_SECURE; the assertion would mask a real regression in MainActivity FLAG_SECURE',
    );
  }
  // (h.7-IO) IO wrapper variant: assertFlagSecureOnForeground on
  // the same fixture must throw with a message mentioning
  // FLAG_SECURE and the package — pin the production-path symmetry.
  let h7IoThrew = false;
  let h7IoMsg = '';
  try {
    await assertFlagSecureOnForeground(
      'selftest',
      () => ({
        stdout: dumpsysFocusOnInsecureAppWindow,
        stderr: '',
        returncode: 0,
      }),
      1,
      0,
    );
  } catch (e) {
    h7IoThrew = true;
    h7IoMsg = (e as Error).message;
  }
  if (!h7IoThrew) {
    failures.push(
      'case (h.7-IO): assertFlagSecureOnForeground did not throw when focused org.enbox.mobile window lacked FLAG_SECURE despite a non-focused FLAG_SECURE window — Round-7 F5 regression branch is dead',
    );
  } else if (!h7IoMsg.includes('FLAG_SECURE') || !h7IoMsg.includes(APP_PACKAGE)) {
    failures.push(
      `case (h.7-IO): assertFlagSecureOnForeground error message missing diagnostic content — got ${JSON.stringify(h7IoMsg.slice(0, 120))}`,
    );
  }
  // (h.8) Round-7 F5: focus on a system_ui overlay. The IO wrapper
  // must throw with a "foreground does not belong to APP_PACKAGE"
  // diagnostic so the operator knows the recovery-phrase screen is
  // not actually visible at the moment of assertion — the assertion
  // cannot vouch for a window the user is not looking at.
  let h8Threw = false;
  let h8Msg = '';
  try {
    await assertFlagSecureOnForeground(
      'selftest',
      () => ({
        stdout: dumpsysFocusOnSystemWindow,
        stderr: '',
        returncode: 0,
      }),
      1,
      0,
    );
  } catch (e) {
    h8Threw = true;
    h8Msg = (e as Error).message;
  }
  if (!h8Threw) {
    failures.push(
      'case (h.8): assertFlagSecureOnForeground did not throw when focus was on a com.android.systemui overlay — recovery-phrase visibility precondition is unverified',
    );
  } else if (!h8Msg.toLowerCase().includes('foreground')) {
    failures.push(
      `case (h.8): assertFlagSecureOnForeground error message missing 'foreground' diagnostic on system-overlay focus case — got ${JSON.stringify(h8Msg.slice(0, 120))}`,
    );
  }
  // (h.9) Round-7 F5: ``mCurrentFocus=null`` (no foreground window).
  // Must throw with a "no foreground window" diagnostic.
  let h9Threw = false;
  let h9Msg = '';
  try {
    await assertFlagSecureOnForeground(
      'selftest',
      () => ({
        stdout: dumpsysFocusNull,
        stderr: '',
        returncode: 0,
      }),
      1,
      0,
    );
  } catch (e) {
    h9Threw = true;
    h9Msg = (e as Error).message;
  }
  if (!h9Threw) {
    failures.push(
      'case (h.9): assertFlagSecureOnForeground did not throw when mCurrentFocus=null — assertion silently passed on a no-focus dumpsys',
    );
  } else if (!h9Msg.toLowerCase().includes('no foreground') &&
             !h9Msg.toLowerCase().includes('null')) {
    failures.push(
      `case (h.9): assertFlagSecureOnForeground error message missing 'no foreground' / 'null' diagnostic — got ${JSON.stringify(h9Msg.slice(0, 120))}`,
    );
  }
  // (h.10) Round-7 F5: older API-level dumpsys with only
  // ``mFocusedWindow=`` (no ``mCurrentFocus=``). The parser must
  // recognise this name as well so the assertion is forward-
  // compatible with older devices.
  if (
    !flagSecureOnFocusedPackageWindow(dumpsysOnlyFocusedWindow, APP_PACKAGE)
  ) {
    failures.push(
      'case (h.10): false negative — flagSecureOnFocusedPackageWindow returned false on dumpsys that uses mFocusedWindow= (older API) instead of mCurrentFocus=',
    );
  }
  // (h.11) Round-8 F1: API-31+ dumpsys variant where
  // ``mCurrentFocus`` / ``mFocusedWindow`` have been moved out of
  // the ``dumpsys window windows`` output and only the
  // activity-level ``mFocusedApp=`` is present. The parser must
  // resolve to the ActivityRecord descriptor, and the
  // FLAG_SECURE check must still succeed because the window block
  // matching that descriptor is still emitted.
  if (
    !flagSecureOnFocusedPackageWindow(dumpsysOnlyFocusedApp, APP_PACKAGE)
  ) {
    failures.push(
      'case (h.11): false negative — flagSecureOnFocusedPackageWindow returned false on a Round-8 F1 fixture using mFocusedApp= (API 31+ dumpsys window). This is the exact regression that blocked the round-7 CI run.',
    );
  }
  // (h.12) Round-8 F1: ``mResumedActivity=`` fallback. Pin the
  // final-fallback parser branch so a future cleanup that drops
  // the ActivityRecord patterns breaks the test instead of
  // silently passing a deviceless run while breaking real CI.
  if (
    !flagSecureOnFocusedPackageWindow(
      dumpsysOnlyResumedActivity,
      APP_PACKAGE,
    )
  ) {
    failures.push(
      'case (h.12): false negative — flagSecureOnFocusedPackageWindow returned false on a Round-8 F1 fixture using mResumedActivity= as the only focus marker',
    );
  }
  // (h.13) Round-8 F1: focus-stabilization retry. The first dumpsys
  // call returns transient ``mCurrentFocus=null`` (a brief window
  // during a navigation transition), the second call returns the
  // real focus. The IO wrapper must NOT throw — this is the exact
  // CI condition that Round-8 F1 fixes. We use a 0s interval to
  // keep the test fast.
  let h13Threw = false;
  let h13Attempts = 0;
  try {
    await assertFlagSecureOnForeground(
      'selftest',
      () => {
        h13Attempts += 1;
        if (h13Attempts === 1) {
          return {stdout: dumpsysFocusNull, stderr: '', returncode: 0};
        }
        return {stdout: dumpsysWithFlag, stderr: '', returncode: 0};
      },
      6,
      0,
    );
  } catch {
    h13Threw = true;
  }
  if (h13Threw) {
    failures.push(
      `case (h.13): assertFlagSecureOnForeground threw on a transient mCurrentFocus=null that resolved on the next dumpsys call (after ${h13Attempts} attempts) — focus-stabilization retry is dead and the assertion would hard-fail any navigation-transition race`,
    );
  } else if (h13Attempts < 2) {
    failures.push(
      `case (h.13): retry budget unused — assertion succeeded after ${h13Attempts} attempt(s) but the fixture only resolves on attempt 2; the IO wrapper is not actually retrying`,
    );
  }
  // (h.14) Round-8 F1: focus-stabilization retry exhaustion. If
  // every retry returns ``mCurrentFocus=null``, the wrapper must
  // eventually throw with the "after N attempts" diagnostic so
  // the operator can tell the failure was a sustained no-focus
  // condition, not a one-off blip.
  let h14Threw = false;
  let h14Msg = '';
  let h14Attempts = 0;
  try {
    await assertFlagSecureOnForeground(
      'selftest',
      () => {
        h14Attempts += 1;
        return {stdout: dumpsysFocusNull, stderr: '', returncode: 0};
      },
      3,
      0,
    );
  } catch (e) {
    h14Threw = true;
    h14Msg = (e as Error).message;
  }
  if (!h14Threw) {
    failures.push(
      'case (h.14): assertFlagSecureOnForeground did not throw when every retry returned mCurrentFocus=null — retry exhaustion branch is dead',
    );
  } else if (!h14Msg.includes('attempts')) {
    failures.push(
      `case (h.14): retry-exhaustion error message missing 'attempts' diagnostic — got ${JSON.stringify(h14Msg.slice(0, 160))}`,
    );
  } else if (h14Attempts !== 3) {
    failures.push(
      `case (h.14): retry budget mismatch — expected 3 dumpsys calls, observed ${h14Attempts}`,
    );
  }

  // -------------------------------------------------------------------
  // (i) Round-9 F1: enrollFingerprint credential-screen matcher.
  //
  // Pre-Round-9 the matcher only recognized the ConfirmLock* family
  // (re-authenticate an existing screen lock). The
  // FINGERPRINT_ENROLL intent on some API 31 google_apis images
  // routes through the ChooseLock* family instead (set NEW screen
  // lock → "Re-enter your PIN" confirmation), bouncing every
  // re-launch attempt back to ChooseLockPassword and exhausting
  // the relaunch budget. This cluster pins:
  //   (i.1) every Confirm* focus descriptor matches the credential
  //         set (back-compat regression guard).
  //   (i.2) every Choose* focus descriptor matches the credential
  //         set (the new branch — proves the ChooseLockPassword
  //         "Re-enter your PIN" focus this round's CI artifacts
  //         observed would now type the PIN instead of bouncing).
  //   (i.3) ChooseLockGeneric matches (the umbrella activity that
  //         the wizard launches first when no lock is set; some
  //         Android 31 builds stop here without descending into a
  //         specific Choose* subclass).
  //   (i.4) non-credential foci (FingerprintEnrollIntroduction,
  //         Launcher, app's own MainActivity) MUST NOT match —
  //         a permissive matcher would silently type the PIN into
  //         our own UI fields.
  //   (i.5) ENROLL_FOCUS_CONFIRM is preserved as a back-compat
  //         alias of ENROLL_FOCUS_CREDENTIAL so any external
  //         test importer keeps working.
  const credentialMatchPositive: ReadonlyArray<readonly [string, string]> = [
    [
      'mFocusedApp=Token{... ActivityRecord{u0 com.android.settings/.password.ConfirmLockPassword}}',
      'i.1.a ConfirmLockPassword',
    ],
    [
      'mCurrentFocus=Window{abc u0 com.android.settings/com.android.settings.password.ConfirmLockPin}',
      'i.1.b ConfirmLockPin',
    ],
    [
      'mFocusedApp=ActivityRecord{u0 com.android.settings/com.android.settings.password.ConfirmLockPattern t12}',
      'i.1.c ConfirmLockPattern',
    ],
    [
      'mFocusedApp=ActivityRecord{u0 com.android.settings/com.android.settings.password.ChooseLockPassword t12}',
      'i.2.a ChooseLockPassword (CI repro)',
    ],
    [
      'mFocusedApp=ActivityRecord{u0 com.android.settings/com.android.settings.password.ChooseLockPin}',
      'i.2.b ChooseLockPin',
    ],
    [
      'mFocusedApp=ActivityRecord{u0 com.android.settings/com.android.settings.password.ChooseLockPattern}',
      'i.2.c ChooseLockPattern',
    ],
    [
      'mFocusedApp=ActivityRecord{u0 com.android.settings/com.android.settings.password.ChooseLockGeneric}',
      'i.3 ChooseLockGeneric umbrella',
    ],
  ];
  for (const [fixture, label] of credentialMatchPositive) {
    if (!focusMatches(fixture, ENROLL_FOCUS_CREDENTIAL)) {
      failures.push(
        `case (${label}): focus did not match ENROLL_FOCUS_CREDENTIAL — ` +
          `enrollFingerprint would NOT type the device PIN on this screen ` +
          `(focus=${JSON.stringify(fixture.slice(0, 160))})`,
      );
    }
  }

  const credentialMatchNegative: ReadonlyArray<readonly [string, string]> = [
    [
      'mFocusedApp=ActivityRecord{u0 com.android.settings/com.android.settings.biometrics.fingerprint.FingerprintEnrollIntroduction}',
      'i.4.a FingerprintEnrollIntroduction',
    ],
    [
      'mFocusedApp=ActivityRecord{u0 com.android.settings/com.android.settings.biometrics.fingerprint.FingerprintEnrollEnrolling}',
      'i.4.b FingerprintEnrollEnrolling',
    ],
    [
      'mFocusedApp=ActivityRecord{u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity}',
      'i.4.c Launcher',
    ],
    [
      'mFocusedApp=ActivityRecord{u0 org.enbox.mobile/org.enbox.mobile.MainActivity}',
      'i.4.d our app — must NEVER receive the PIN keystrokes',
    ],
  ];
  for (const [fixture, label] of credentialMatchNegative) {
    if (focusMatches(fixture, ENROLL_FOCUS_CREDENTIAL)) {
      failures.push(
        `case (${label}): focus matched ENROLL_FOCUS_CREDENTIAL — ` +
          `enrollFingerprint would incorrectly type the device PIN on this surface ` +
          `(focus=${JSON.stringify(fixture.slice(0, 160))})`,
      );
    }
  }

  // (i.5) Back-compat alias.
  if (ENROLL_FOCUS_CONFIRM !== (ENROLL_FOCUS_CREDENTIAL as readonly string[])) {
    failures.push(
      'case (i.5): ENROLL_FOCUS_CONFIRM is no longer aliased to ENROLL_FOCUS_CREDENTIAL — ' +
        'external importers (tests, validation scripts) of the legacy name will see a stale matcher set',
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
  logInfo(
    '  (h) flagSecureOnFocusedPackageWindow + assertFlagSecureOnForeground: focus-aware parser & IO-wrapper contracts pinned (positive, negative, no-package, dumpsys-failure, throw-message, FOCUS-on-insecure-app-window, focus-on-system-overlay, focus=null, mFocusedWindow-only, mFocusedApp-only [Round-8 F1], mResumedActivity-only [Round-8 F1], focus-stabilization-retry-success [Round-8 F1], focus-stabilization-retry-exhaustion [Round-8 F1])',
  );
  logInfo(
    '  (i) ENROLL_FOCUS_CREDENTIAL [Round-9 F1]: ConfirmLockPassword/Pin/Pattern + ChooseLockPassword/Pin/Pattern/Generic positive matches; FingerprintEnrollIntroduction/Enrolling, Launcher, our app are correctly REJECTED; ENROLL_FOCUS_CONFIRM back-compat alias preserved',
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
