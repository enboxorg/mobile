/**
 * Cross-area integration test — VAL-CROSS-014.
 *
 * Verifies the biometric-first refactor did NOT regress the
 * `enbox://` URL scheme registration that the wallet-connect deep-link
 * flow depends on:
 *
 *   - iOS:    `ios/EnboxMobile/Info.plist` declares a `CFBundleURLTypes`
 *             entry with `CFBundleURLSchemes` containing `enbox`.
 *   - Android: `android/app/src/main/AndroidManifest.xml` declares an
 *             `<intent-filter>` on `MainActivity` with
 *             `<data android:scheme="enbox" android:host="connect"/>`.
 *
 * The Jest test parses each file at runtime so the assertion runs on
 * every CI pass (no manual grep required).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');

const INFO_PLIST = join(
  REPO_ROOT,
  'ios',
  'EnboxMobile',
  'Info.plist',
);

const ANDROID_MANIFEST = join(
  REPO_ROOT,
  'android',
  'app',
  'src',
  'main',
  'AndroidManifest.xml',
);

describe('VAL-CROSS-014 — enbox:// URL scheme registration unchanged', () => {
  it('iOS Info.plist still declares the `enbox` URL scheme', () => {
    const contents = readFileSync(INFO_PLIST, 'utf-8');

    // CFBundleURLTypes dictionary entry must be present.
    expect(contents).toMatch(/<key>CFBundleURLTypes<\/key>/);

    // The CFBundleURLSchemes array must include the `enbox` scheme.
    // We match across newlines / indentation to be robust against
    // future XML reformatting.
    const schemesBlock = contents.match(
      /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/,
    );
    expect(schemesBlock).not.toBeNull();
    const schemes = schemesBlock?.[1] ?? '';
    expect(schemes).toMatch(/<string>enbox<\/string>/);
  });

  it('Android manifest still declares the intent-filter for enbox://connect', () => {
    const contents = readFileSync(ANDROID_MANIFEST, 'utf-8');

    // Must still register USE_BIOMETRIC (regression guard — milestone 2).
    expect(contents).toMatch(
      /uses-permission\s+android:name="android\.permission\.USE_BIOMETRIC"/,
    );

    // android.intent.action.VIEW intent filter with BROWSABLE category.
    expect(contents).toMatch(
      /<action\s+android:name="android\.intent\.action\.VIEW"\s*\/>/,
    );
    expect(contents).toMatch(
      /<category\s+android:name="android\.intent\.category\.BROWSABLE"\s*\/>/,
    );

    // `<data android:scheme="enbox" android:host="connect" />`.
    // Attribute order isn't guaranteed, so assert both attributes
    // appear on the same `<data>` tag.
    const dataTags = Array.from(
      contents.matchAll(/<data\b[^>]*\/>/g),
      (m) => m[0],
    );
    const hasEnboxConnect = dataTags.some(
      (tag) =>
        /android:scheme="enbox"/.test(tag) &&
        /android:host="connect"/.test(tag),
    );
    expect(hasEnboxConnect).toBe(true);
  });

  it('MainActivity is exported (required for deep-link resolution)', () => {
    const contents = readFileSync(ANDROID_MANIFEST, 'utf-8');
    // android:exported is required on API 31+ for any activity with an
    // intent-filter. Regression guard — without it the deep link
    // silently fails to resolve.
    expect(contents).toMatch(/android:name="\.MainActivity"[\s\S]*?android:exported="true"/);
  });
});
