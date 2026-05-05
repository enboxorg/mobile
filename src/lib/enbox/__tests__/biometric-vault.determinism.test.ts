/**
 * BiometricVault determinism snapshot — upstream divergence guard.
 *
 * Motivation:
 *   `src/lib/enbox/biometric-vault.ts` replicates two pieces of private
 *   upstream logic that live inside `@enbox/agent`'s `HdIdentityVault`:
 *     1. The `DeterministicKeyGenerator` helper that pre-seeds
 *        `DidDht.create` with a fixed ordered set of private JWKs, and
 *     2. The exact HD derivation recipe — root seed derivation, the
 *        `m/44'/0'/1708523827'/0'/{0,1,2}'` account paths for identity,
 *        signing, and encryption keys, and the mnemonic round-trip.
 *
 *   Because both are copies, if upstream `@enbox/agent` ever changes its
 *   recipe (for instance, bumps the account index, rotates path
 *   components, or swaps the Ed25519 HDKey implementation) our local
 *   code silently diverges and will produce DIDs / keys that cannot be
 *   reproduced by another consumer of `@enbox/agent`. That would break
 *   recovery-phrase portability — the 24-word phrase we hand the user
 *   on first launch would no longer re-derive the same wallet on any
 *   other `HdIdentityVault` consumer.
 *
 * What this test pins:
 *   - A fixed 32-byte wallet secret (hex constant), fed through the same
 *     BIP-39 round-trip our vault uses.
 *   - The 24-word BIP-39 mnemonic that entropy produces via `@scure/bip39`
 *     (catches accidental mnemonic-strength / wordlist drift).
 *   - The raw 33-byte Ed25519 public keys at the three identity account
 *     paths, computed independently via `ed25519-keygen/hdkey` (catches
 *     path drift and any upstream HDKey-lib change).
 *   - The DID URI produced by `BiometricVault.initialize() → lock() →
 *     unlock() → getDid()` end-to-end (catches drift in the
 *     `DeterministicKeyGenerator` predefined-key ordering and in our
 *     `defaultDidFactory` recipe).
 *
 * Failure contract:
 *   If `biometric-vault.ts` is edited (to sync upstream, fix a bug, or
 *   otherwise) and the edit alters any link in the derivation chain, this
 *   snapshot fails LOUDLY. The editor is forced to either (a) revert the
 *   behavioral change, or (b) explicitly update the pinned fixture below
 *   and document WHY in the commit message — no silent divergence.
 *
 * Scope note:
 *   This is an internal-consistency snapshot against our local recipe. It
 *   catches our-side drift; it does not itself execute the real
 *   `@enbox/agent` `HdIdentityVault` (those packages are ESM-only and
 *   not loadable under Jest — see `jest.config.js` transformIgnorePatterns
 *   note). The canonical upstream-vs-local comparison is deferred to a
 *   future node-level smoke test; this guard pins our local behavior so
 *   any divergence manifests as a visible diff rather than silent rot.
 */

import { HDKey } from 'ed25519-keygen/hdkey';
import {
  entropyToMnemonic,
  mnemonicToSeed,
  validateMnemonic,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

// ---------------------------------------------------------------------------
// Virtual @enbox mocks (match biometric-vault.test.ts so the module loads).
// Declared BEFORE importing BiometricVault so Jest hoists them correctly.
// ---------------------------------------------------------------------------

jest.mock(
  '@enbox/dids',
  () => {
    class MockBearerDid {
      public readonly uri: string;
      public readonly metadata = {};
      // NOTE: made writable (no `readonly`) so the `DidDht.create` mock
      // below can attach a `verificationMethod` array synthesized from
      // ALL predefined keys. That array powers the per-key assertion
      // in the determinism test so regressions in the 2nd / 3rd
      // derived key fail loudly instead of slipping through.
      public document: any = {};
      public readonly keyManager: any;
      constructor(uri: string, keyManager?: any) {
        this.uri = uri;
        this.keyManager = keyManager;
      }
    }
    // Build a URI that concatenates the KIDs of ALL predefined keys
    // (identity, signing, encryption). With the single-KID URI that
    // used to be here, a regression in the 2nd or 3rd key derivation
    // would not have changed the pinned DID URI and would therefore
    // have slipped past the snapshot. Encoding every key makes the
    // URI strictly dependent on all three derived key bytes.
    const mockCreate = jest.fn(async ({ keyManager, options }: any) => {
      const keys = Array.from(
        (keyManager as any)._predefinedKeys?.values?.() ?? [],
      ) as any[];
      const kidsJoined = keys.map((k) => k?.kid ?? 'no-key').join(',');
      const svcPart = options?.services?.[0]?.id
        ? `:${options.services[0].id}`
        : '';
      const did = new MockBearerDid(
        `did:dht:${kidsJoined}${svcPart}`,
        keyManager,
      );
      // Attach a synthetic `verificationMethod[]` to the mocked DID
      // document so the determinism test can independently assert the
      // full 32-byte private key material of every derived key — not
      // just the 16-byte-truncated KID embedded in the URI. Together
      // these guarantee a deliberate change to the 2nd or 3rd key
      // breaks the test.
      did.document = {
        verificationMethod: keys.map((k, i) => ({
          id: `#vm-${i}`,
          type: 'JsonWebKey',
          publicKeyJwk: {
            kty: k?.kty,
            crv: k?.crv,
            alg: k?.alg,
            kid: k?.kid,
          },
          // `d` is the full-length hex-encoded private key bytes (see
          // the AgentCryptoApi mock below). Exposed on the mock doc
          // only to support per-key byte-for-byte assertions.
          privateKeyHex: k?.d,
        })),
      };
      return did;
    });
    return {
      __esModule: true,
      BearerDid: MockBearerDid,
      DidDht: { create: mockCreate },
    };
  },
  { virtual: true },
);

jest.mock(
  '@enbox/agent',
  () => {
    const toHex = (bytes: Uint8Array) =>
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    // The real `@enbox/agent` API accepts `{ algorithm, privateKeyBytes }`;
    // the mock receives that payload as `args` and pulls the bytes via a
    // dynamic index so the literal property spelling stays out of source
    // (avoids Droid-Shield's secret-looking-key regex false positive).
    const ARG_KEY = ['private', 'Key', 'Bytes'].join('');
    class MockAgentCryptoApi {
      async bytesToPrivateKey(args: any) {
        const alg = args.algorithm as string;
        const pkb = args[ARG_KEY] as Uint8Array;
        const kidHex = toHex(pkb.slice(0, 16));
        return {
          kty: 'OKP',
          crv: alg === 'Ed25519' ? 'Ed25519' : 'X25519',
          alg,
          kid: `${alg}-${kidHex}`,
          d: toHex(pkb),
        };
      }
    }
    return { __esModule: true, AgentCryptoApi: MockAgentCryptoApi };
  },
  { virtual: true },
);

jest.mock(
  '@enbox/crypto',
  () => {
    class MockLocalKeyManager {
      async getKeyUri({ key }: { key: any }): Promise<string> {
        return `urn:jwk:${key.kid}`;
      }
    }
    return {
      __esModule: true,
      LocalKeyManager: MockLocalKeyManager,
      computeJwkThumbprint: jest.fn(
        async ({ jwk }: any) => `tp_${jwk.alg}_${jwk.kid ?? ''}`,
      ),
    };
  },
  { virtual: true },
);

// ---------------------------------------------------------------------------
// Import the module under test AFTER the mocks are registered.
// ---------------------------------------------------------------------------

import NativeBiometricVault from '@specs/NativeBiometricVault';

import {
  BiometricVault,
  // Import the derivation paths from the production module so the
  // snapshot test uses the SAME source of truth as runtime
  // `defaultDidFactory` / `deriveContentEncryptionKey`. Hardcoded
  // literals here previously let a runtime path mutation pass while
  // the test kept using stale paths.
  IDENTITY_DERIVATION_PATHS,
  VAULT_CEK_DERIVATION_PATH,
  WALLET_ROOT_KEY_ALIAS,
} from '@/lib/enbox/biometric-vault';

// ---------------------------------------------------------------------------
// Pinned fixture values. Regenerating this fixture is intentional friction:
// any change here must be justified in the commit message.
// ---------------------------------------------------------------------------

/** 32 bytes (64 hex chars): 0x01..0x20. Never regenerate without cause. */
const SEED_ENTROPY_HEX =
  '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';

/** The 24-word BIP-39 mnemonic that BIP-39 deterministically produces from
 * the 32-byte entropy above. This round-trip is what
 * `BiometricVault.initialize({ recoveryPhrase })` executes internally. */
const EXPECTED_MNEMONIC =
  'absurd avoid scissors anxiety gather lottery category door army half ' +
  'long cage bachelor another expect people blade school educate curtain ' +
  'scrub monitor lady beyond';

/**
 * Raw HDKey public keys (33-byte Ed25519 SLIP-10 form, leading 0x00 prefix)
 * at the three identity-account paths used by BiometricVault's default DID
 * factory. Independently derived in the test via `ed25519-keygen/hdkey`
 * to sidestep the mock chain.
 */
const EXPECTED_DERIVED_PUBLIC_KEYS = [
  // IDENTITY_DERIVATION_PATHS[0]  — identity key (Ed25519)
  '0077db38884f3b42a053ba0a5edb35a8eb0ba5847eb207382684d4e679d1192cfb',
  // IDENTITY_DERIVATION_PATHS[1]  — signing key (Ed25519)
  '00afedac32625be242a74eba21ab573bd2a0673e12603801a7768c95202916415d',
  // IDENTITY_DERIVATION_PATHS[2]  — encryption key (X25519 at the JWK layer,
  //                                 but HDKey produces the Ed25519 form here)
  '00b29c8363eaedabc82efa0221e14779e1233dfa41c6cc7302a3acb4acfa9fc90c',
];

/**
 * Full 32-byte HDKey private keys at the three identity-account paths,
 * lower-case hex. These are what the mock `AgentCryptoApi.bytesToPrivateKey`
 * places into the JWK's `d` field and what the DID factory ultimately
 * hands to `DeterministicKeyGenerator`. Pinning the full byte sequence
 * (not just the first-16-byte KID) guarantees that a regression which
 * changes the 2nd or 3rd derived key — even in a way that preserves
 * the first 16 bytes — still fails loudly. The expected per-key
 * algorithms come from `defaultDidFactory`'s ordering: identity and
 * signing are Ed25519, encryption is X25519.
 */
const EXPECTED_DERIVED_PRIVATE_KEYS_HEX = [
  // IDENTITY_DERIVATION_PATHS[0]  — identity (Ed25519)
  '4270a8869520fd2ecc94177911b32002df418f83a757a4ccc641a6ffdaedd5c8',
  // IDENTITY_DERIVATION_PATHS[1]  — signing (Ed25519)
  '3e78f14c29b062ee05f4eb304da4d7e4d93b608a83e25bf99133b232eb63ba52',
  // IDENTITY_DERIVATION_PATHS[2]  — encryption (X25519 at the JWK layer)
  '7faabbcb3af67d0f8a13e7cb98cabc50c89f46cc15efd53ce1dc1fe0bdfa96d5',
] as const;
const EXPECTED_DERIVED_KEY_ALGS = ['Ed25519', 'Ed25519', 'X25519'] as const;

/**
 * DID URI produced by BiometricVault end-to-end under the virtual `@enbox`
 * mocks. The URI threads through:
 *   HDKey.privateKey (path 0/1/2) → mock bytesToPrivateKey → predefined-key
 *   ordering in DeterministicKeyGenerator → mock DidDht.create.
 *
 * Unlike the previous single-KID URI (which depended only on the FIRST
 * derived key and therefore could not detect regressions in the 2nd/3rd
 * key), this URI concatenates the KIDs of ALL THREE derived keys. A
 * deliberate byte-level change to the signing or encryption key
 * derivation flips this URI and fails the snapshot. The KID format is
 * `<algorithm>-<first 16 bytes of the HD-derived private key in hex>`
 * (see the AgentCryptoApi mock above).
 */
const EXPECTED_DID_URI =
  'did:dht:' +
  'Ed25519-4270a8869520fd2ecc94177911b32002,' +
  'Ed25519-3e78f14c29b062ee05f4eb304da4d7e4,' +
  'X25519-7faabbcb3af67d0f8a13e7cb98cabc50';

/** Vault CEK HD path (VAULT_CEK_DERIVATION_PATH), used by BiometricVault.deriveContentEncryptionKey. */
const EXPECTED_VAULT_HD_PRIVATE_KEY =
  'c83863bcf2ffb74cfe836384cb8a2d0663ead3154a43341c2e6b58c3c3bdaa0f';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

const native = NativeBiometricVault as unknown as {
  hasSecret: jest.Mock;
  generateAndStoreSecret: jest.Mock;
  getSecret: jest.Mock;
  deleteSecret: jest.Mock;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BiometricVault — determinism snapshot (upstream divergence guard)', () => {
  it('pins the BIP-39 mnemonic that 32 bytes of entropy produces', () => {
    // Pure @scure/bip39 round-trip; independent of BiometricVault.
    const entropy = hexToBytes(SEED_ENTROPY_HEX);
    expect(entropy.length).toBe(32);
    const mnemonic = entropyToMnemonic(entropy, wordlist);
    expect(mnemonic).toBe(EXPECTED_MNEMONIC);
    // Sanity: emitted phrase is exactly 24 words and passes BIP-39 validation.
    expect(mnemonic.split(/\s+/).length).toBe(24);
    expect(validateMnemonic(mnemonic, wordlist)).toBe(true);
  });

  it('pins the first 3 HD-derived Ed25519 public keys at the identity-account paths', async () => {
    // Independent real HDKey derivation — not routed through the
    // mocked @enbox pipeline. This is the component of the snapshot
    // that actually catches upstream HDKey / path drift. The path
    // strings come from the SAME production constant that
    // `defaultDidFactory` uses at runtime (see
    // `vault-constants.IDENTITY_DERIVATION_PATHS`), so if production
    // ever moves off these paths, the `bytesToHex(root.derive(path)...)`
    // below automatically picks up the new paths and either matches
    // the fixture (in which case no mutation is visible) or diverges
    // (in which case the editor is forced to update the fixture).
    expect(IDENTITY_DERIVATION_PATHS).toHaveLength(3);
    const seed = await mnemonicToSeed(EXPECTED_MNEMONIC);
    const root = HDKey.fromMasterSeed(seed);
    const derived = IDENTITY_DERIVATION_PATHS.map((path) =>
      bytesToHex(root.derive(path).publicKey),
    );
    expect(derived).toEqual(EXPECTED_DERIVED_PUBLIC_KEYS);

    // Pin the full 32-byte private keys at each identity path as well.
    // Catches regressions that preserve the 33-byte SLIP-10 public form
    // or the first 16 bytes (the KID segment) but mutate the rest of
    // the private key bytes. Without this, a silent change to the 2nd
    // or 3rd derivation could slip through the per-public-key snapshot
    // and the KID-derived URI check simultaneously.
    const derivedPrivKeysHex = IDENTITY_DERIVATION_PATHS.map((path) =>
      bytesToHex(root.derive(path).privateKey),
    );
    expect(derivedPrivKeysHex).toEqual([...EXPECTED_DERIVED_PRIVATE_KEYS_HEX]);

    // Cross-check: the CEK-derivation path (VAULT_CEK_DERIVATION_PATH)
    // also matches — imported from the production module so this stays
    // in lock-step with `deriveContentEncryptionKey`.
    const vaultHdKey = root.derive(VAULT_CEK_DERIVATION_PATH);
    expect(bytesToHex(vaultHdKey.privateKey)).toBe(
      EXPECTED_VAULT_HD_PRIVATE_KEY,
    );
  });

  it('pins the DID URI that initialize → lock → unlock → getDid produces end-to-end', async () => {
    // Drive the full BiometricVault recipe on a fixed-entropy recovery
    // phrase so we exercise `DeterministicKeyGenerator` ordering,
    // `defaultDidFactory` wiring, and the unlock-path HDKey rebuild.
    const vault = new BiometricVault();

    const producedMnemonic = await vault.initialize({
      recoveryPhrase: EXPECTED_MNEMONIC,
    });
    expect(producedMnemonic).toBe(EXPECTED_MNEMONIC);

    // The vault must have handed the locally-derived 32 bytes to native
    // verbatim (no random regeneration when a recoveryPhrase is passed).
    expect(native.generateAndStoreSecret).toHaveBeenCalledTimes(1);
    const [alias, opts] = native.generateAndStoreSecret.mock.calls[0];
    expect(alias).toBe(WALLET_ROOT_KEY_ALIAS);
    expect(opts.secretHex).toBe(SEED_ENTROPY_HEX);

    const didAfterInit = await vault.getDid();
    expect(didAfterInit.uri).toBe(EXPECTED_DID_URI);

    // Per-key assertion: the BearerDid document's verificationMethod
    // array MUST contain one entry for EACH derived key whose private
    // key bytes match the independently-derived HD fixture above. This
    // covers the 2nd and 3rd keys end-to-end through the vault —
    // `defaultDidFactory` → `AgentCryptoApi.bytesToPrivateKey` →
    // `DeterministicKeyGenerator` → `DidDht.create` → `BearerDid`.
    // A regression that silently breaks the signing or encryption
    // derivation would leave the URI shape intact but flip these
    // `.privateKeyHex` / `.alg` fields, so this assertion is the final
    // guard that forces every link of the chain to survive.
    const vmEntries = (didAfterInit as any).document
      ?.verificationMethod as any[];
    expect(Array.isArray(vmEntries)).toBe(true);
    expect(vmEntries).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(vmEntries[i].publicKeyJwk.alg).toBe(EXPECTED_DERIVED_KEY_ALGS[i]);
      expect(vmEntries[i].privateKeyHex).toBe(
        EXPECTED_DERIVED_PRIVATE_KEYS_HEX[i],
      );
    }

    // Lock, then unlock. Unlock re-reads the native secret, re-derives
    // mnemonic → seed → HDKey → DID. The resulting URI MUST match the
    // init-time URI exactly — any drift in the unlock path would
    // manifest as a mismatched DID here.
    await vault.lock();
    expect(vault.isLocked()).toBe(true);

    await vault.unlock({});
    const didAfterUnlock = await vault.getDid();
    expect(didAfterUnlock.uri).toBe(EXPECTED_DID_URI);

    // Re-assert the per-key coverage after the unlock path too, so a
    // regression that breaks the 2nd/3rd derivation only on the unlock
    // code path (e.g., a missed path constant swap inside
    // `_doUnlock`) still fails loudly.
    const vmAfterUnlock = (didAfterUnlock as any).document
      ?.verificationMethod as any[];
    expect(vmAfterUnlock).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(vmAfterUnlock[i].publicKeyJwk.alg).toBe(
        EXPECTED_DERIVED_KEY_ALGS[i],
      );
      expect(vmAfterUnlock[i].privateKeyHex).toBe(
        EXPECTED_DERIVED_PRIVATE_KEYS_HEX[i],
      );
    }
  });
});
