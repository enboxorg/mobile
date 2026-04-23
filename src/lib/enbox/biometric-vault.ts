/**
 * BiometricVault — biometric-first IdentityVault implementation.
 *
 * Implements `@enbox/agent`'s `IdentityVault<{ InitializeResult: string }>`
 * interface. Instead of a password-based CEK the vault stores a single
 * 256-bit random secret under the OS biometric-gated keystore
 * (`NativeBiometricVault`). That secret is the canonical root entropy
 * from which the 24-word BIP-39 mnemonic, the HD seed, and the
 * `BearerDid` are deterministically derived on every unlock.
 *
 * Responsibilities:
 *   - Gate provisioning (`initialize()`) on `hasSecret()` so we never
 *     overwrite a live vault.
 *   - Prompt biometrics to retrieve the secret during `unlock()`.
 *   - Keep the derived seed / DID / CEK in memory only; `lock()` clears
 *     them, leaving the native secret intact.
 *   - Translate native error codes into stable `VAULT_ERROR_*` codes so
 *     the UI can route the user (invalidated -> recovery, cancel -> retry,
 *     etc.).
 *   - Serialize concurrent `initialize()` / `unlock()` calls via an
 *     internal mutex so a double-tap on the CTA results in a single
 *     native prompt.
 */

import { HDKey } from 'ed25519-keygen/hdkey';
import {
  entropyToMnemonic,
  mnemonicToEntropy,
  mnemonicToSeed,
  validateMnemonic,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

import type {
  IdentityVault,
  IdentityVaultBackup,
  IdentityVaultStatus,
} from '@enbox/agent';
import { AgentCryptoApi } from '@enbox/agent';
import { BearerDid, DidDht } from '@enbox/dids';
import { LocalKeyManager, computeJwkThumbprint } from '@enbox/crypto';

import NativeBiometricVault from '@specs/NativeBiometricVault';

import {
  BIOMETRIC_STATE_STORAGE_KEY,
  INITIALIZED_STORAGE_KEY,
  WALLET_ROOT_KEY_ALIAS,
} from './vault-constants';

// Re-export the shared constants from the pure `vault-constants` module
// so existing callers (including the test suite) that import them from
// `@/lib/enbox/biometric-vault` continue to resolve. The canonical
// declaration lives in `vault-constants.ts`; see that module's header
// comment for the circular-import rationale.
export {
  BIOMETRIC_STATE_STORAGE_KEY,
  INITIALIZED_STORAGE_KEY,
  WALLET_ROOT_KEY_ALIAS,
};

/** Default biometric prompt copy for unlock flows. */
export const DEFAULT_UNLOCK_PROMPT = {
  promptTitle: 'Unlock Enbox',
  promptMessage: 'Unlock your Enbox wallet with biometrics',
  promptCancel: 'Cancel',
};

/** Prompt used right after provisioning so biometrics are verified once. */
export const DEFAULT_PROVISION_PROMPT = {
  promptTitle: 'Set up biometric unlock',
  promptMessage: 'Confirm biometrics to finish setup',
  promptCancel: 'Cancel',
};

/**
 * Canonical error codes raised by BiometricVault. These are the codes
 * that `agent-store`, navigation, and user-facing screens gate on — do
 * not introduce new codes without extending the validation contract.
 */
export const VAULT_ERROR_CODES = [
  'VAULT_ERROR_ALREADY_INITIALIZED',
  'VAULT_ERROR_NOT_INITIALIZED',
  'VAULT_ERROR_LOCKED',
  'VAULT_ERROR_BIOMETRICS_UNAVAILABLE',
  'VAULT_ERROR_BIOMETRY_LOCKOUT',
  'VAULT_ERROR_USER_CANCELED',
  'VAULT_ERROR_KEY_INVALIDATED',
  'VAULT_ERROR_UNSUPPORTED',
  'VAULT_ERROR',
] as const;

export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[number];

export class VaultError extends Error {
  public readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'VaultError';
    this.code = code;
  }
}

/** Subset of biometric states needed by the UX gate matrix. */
export type BiometricState = 'unknown' | 'unavailable' | 'ready' | 'invalidated';

export interface BiometricVaultStatus extends IdentityVaultStatus {
  biometricState: BiometricState;
}

/**
 * Minimal `@enbox/auth`-compatible SecureStorage surface the vault uses
 * to persist one-bit signals (`initialized`, `biometric-state`). We
 * intentionally avoid a full `StorageAdapter` dependency to make the
 * vault easy to construct in tests.
 */
export interface SecureStorageLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Options accepted by the BiometricVault constructor. */
export interface BiometricVaultOptions {
  /** Optional persistent secure storage for one-bit state flags. */
  secureStorage?: SecureStorageLike;
  /** Optional override of the native biometric module (for tests). */
  biometricVault?: typeof NativeBiometricVault;
  /** Optional override of the `AgentCryptoApi` used for key coercion. */
  cryptoApi?: { bytesToPrivateKey: (params: { algorithm: string; privateKeyBytes: Uint8Array }) => Promise<any> };
  /** Override the DID resolver / creator (for tests). */
  didFactory?: (args: { rootHdKey: any; dwnEndpoints?: string[] }) => Promise<BearerDid>;
  /** Override the biometric unlock prompt copy. */
  unlockPrompt?: typeof DEFAULT_UNLOCK_PROMPT;
  /** Override the biometric provision prompt copy. */
  provisionPrompt?: typeof DEFAULT_PROVISION_PROMPT;
}

/**
 * Deterministic key manager that feeds pre-computed JWKs to
 * `DidDht.create`. Mirrors the internal `DeterministicKeyGenerator`
 * used by `HdIdentityVault` upstream so the resulting DID is
 * byte-for-byte identical for a given root HD seed.
 */
class DeterministicKeyGenerator extends LocalKeyManager {
  // Keep predefined keys ordered so `generateKey` returns them in order.
  private _predefinedKeys: Map<string, any> = new Map();
  private _iterator: IterableIterator<string> | undefined;

  async addPredefinedKeys({ privateKeys }: { privateKeys: any[] }): Promise<void> {
    const entries: Record<string, any> = {};
    for (const key of privateKeys) {
      if (!key.kid) {
        key.kid = await computeJwkThumbprint({ jwk: key });
      }
      const keyUri = await this.getKeyUri({ key });
      entries[keyUri] = key;
    }
    this._predefinedKeys = new Map(Object.entries(entries));
    this._iterator = this._predefinedKeys.keys();
  }

  async exportKey({ keyUri }: { keyUri: string }): Promise<any> {
    const pk = this._predefinedKeys.get(keyUri);
    if (!pk) {
      throw new Error(`DeterministicKeyGenerator.exportKey: Key not found: ${keyUri}`);
    }
    return pk;
  }

  async generateKey(_params: unknown): Promise<string> {
    if (!this._iterator) {
      throw new Error('DeterministicKeyGenerator: no keys added');
    }
    const { value, done } = this._iterator.next();
    if (done) {
      throw new Error('DeterministicKeyGenerator: ran out of predefined keys');
    }
    return value;
  }

  async getPublicKey({ keyUri }: { keyUri: string }): Promise<any> {
    const pk = this._predefinedKeys.get(keyUri);
    if (!pk) {
      throw new Error(`DeterministicKeyGenerator.getPublicKey: Key not found: ${keyUri}`);
    }
    // Strip the private component (`d`) if present.
    const pub = { ...pk };
    delete pub.d;
    return pub;
  }
}

/**
 * Default BearerDid derivation — mirrors `HdIdentityVault`'s DID recipe
 * so the produced BearerDid.uri is deterministic w.r.t. the root HD key.
 */
async function defaultDidFactory({
  rootHdKey,
  dwnEndpoints,
  cryptoApi,
}: {
  rootHdKey: any;
  dwnEndpoints?: string[];
  cryptoApi: BiometricVaultOptions['cryptoApi'];
}): Promise<BearerDid> {
  const crypto = cryptoApi ?? new AgentCryptoApi();

  // Match the exact derivation paths from HdIdentityVault so the produced
  // DID is identical to what that vault would have produced from the same
  // mnemonic. The account index is pinned for deterministic replay.
  const identityHdKey = rootHdKey.derive(`m/44'/0'/1708523827'/0'/0'`);
  const signingHdKey = rootHdKey.derive(`m/44'/0'/1708523827'/0'/1'`);
  const encryptionHdKey = rootHdKey.derive(`m/44'/0'/1708523827'/0'/2'`);

  const identityPrivateKey = await crypto.bytesToPrivateKey({
    algorithm: 'Ed25519',
    privateKeyBytes: identityHdKey.privateKey,
  });
  const signingPrivateKey = await crypto.bytesToPrivateKey({
    algorithm: 'Ed25519',
    privateKeyBytes: signingHdKey.privateKey,
  });
  const encryptionPrivateKey = await crypto.bytesToPrivateKey({
    algorithm: 'X25519',
    privateKeyBytes: encryptionHdKey.privateKey,
  });

  const keyManager = new DeterministicKeyGenerator();
  await keyManager.addPredefinedKeys({
    privateKeys: [identityPrivateKey, signingPrivateKey, encryptionPrivateKey],
  });

  const options: any = {
    verificationMethods: [
      {
        algorithm: 'Ed25519',
        id: 'sig',
        purposes: ['assertionMethod', 'authentication'],
      },
      {
        algorithm: 'X25519',
        id: 'enc',
        purposes: ['keyAgreement'],
      },
    ],
  };
  if (dwnEndpoints && dwnEndpoints.length > 0) {
    options.services = [
      {
        id: 'dwn',
        type: 'DecentralizedWebNode',
        serviceEndpoint: dwnEndpoints,
      },
    ];
  }

  return (await DidDht.create({ keyManager: keyManager as any, options })) as BearerDid;
}

/** Decode a lower-case hex string into a Uint8Array; throws on odd length. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new VaultError('VAULT_ERROR', 'Odd-length hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encode bytes as a lower-case hex string. */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Generate 32 cryptographically random bytes for the wallet's root
 * secret. Uses `crypto.getRandomValues` which is provided by
 * react-native-quick-crypto in the app and by Node's built-in
 * `crypto.webcrypto` in Jest.
 */
function generateWalletSecretBytes(): Uint8Array {
  const out = new Uint8Array(32);
  const g = (globalThis as any).crypto;
  if (g && typeof g.getRandomValues === 'function') {
    g.getRandomValues(out);
    return out;
  }
  throw new VaultError(
    'VAULT_ERROR',
    'crypto.getRandomValues is not available to generate wallet secret',
  );
}

function zeroBytes(bytes: Uint8Array | undefined) {
  if (bytes) bytes.fill(0);
}

function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  const globalBtoa = (globalThis as any).btoa as ((s: string) => string) | undefined;
  const b64 = globalBtoa
    ? globalBtoa(binary)
    : Buffer.from(arr).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const globalAtob = (globalThis as any).atob as ((s: string) => string) | undefined;
  if (globalAtob) {
    const bin = globalAtob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Derive a 32-byte content encryption key bound to the root HD key. */
async function deriveContentEncryptionKey(rootHdKey: any): Promise<Uint8Array> {
  // Reuse HdIdentityVault's vault HD key derivation path so the CEK
  // rides the same deterministic chain as the DID.
  const vaultHdKey = rootHdKey.derive(`m/44'/0'/0'/0'/0'`);
  const priv = vaultHdKey.privateKey as Uint8Array;
  // HKDF via WebCrypto (available both on RN via react-native-quick-crypto
  // and in Node >= 20 used by Jest).
  const subtle: SubtleCrypto = (globalThis as any).crypto?.subtle;
  if (subtle && typeof subtle.deriveBits === 'function') {
    try {
      const base = await subtle.importKey('raw', priv as any, 'HKDF', false, [
        'deriveBits',
      ]);
      const bits = await subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new Uint8Array(0) as any,
          info: new TextEncoder().encode('enbox-biometric-vault-cek') as any,
        } as any,
        base,
        256,
      );
      return new Uint8Array(bits);
    } catch {
      // Fall through to SHA-256 digest below.
    }
  }
  if (subtle && typeof subtle.digest === 'function') {
    const digest = await subtle.digest('SHA-256', priv as any);
    return new Uint8Array(digest);
  }
  // Ultimate fallback: use the raw vault private key (32 bytes).
  return priv.slice(0, 32);
}

async function aesGcmEncrypt(cek: Uint8Array, plaintext: Uint8Array): Promise<string> {
  const subtle: SubtleCrypto = (globalThis as any).crypto?.subtle;
  if (!subtle) {
    throw new VaultError('VAULT_ERROR', 'WebCrypto SubtleCrypto not available');
  }
  const key = await subtle.importKey(
    'raw',
    cek as any,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = (globalThis as any).crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: iv as any }, key, plaintext as any),
  );
  const header = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })),
  );
  // Compact JWE: header..iv.ciphertext+tag.<empty tag segment>
  return `${header}..${toBase64Url(iv)}.${toBase64Url(ct)}.`;
}

async function aesGcmDecrypt(cek: Uint8Array, jwe: string): Promise<Uint8Array> {
  const subtle: SubtleCrypto = (globalThis as any).crypto?.subtle;
  if (!subtle) {
    throw new VaultError('VAULT_ERROR', 'WebCrypto SubtleCrypto not available');
  }
  const parts = jwe.split('.');
  if (parts.length !== 5) {
    throw new VaultError('VAULT_ERROR', 'Invalid compact JWE');
  }
  const iv = fromBase64Url(parts[2]);
  const ct = fromBase64Url(parts[3]);
  const key = await subtle.importKey(
    'raw',
    cek as any,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: iv as any }, key, ct as any);
  return new Uint8Array(pt);
}

/**
 * Map a native module error (`{ code, message }`) to a canonical vault
 * error. Returns `null` if the error is unknown / has no `.code` so the
 * caller can fall through to `VAULT_ERROR`.
 */
export function mapNativeErrorToVaultError(err: unknown): VaultError | null {
  const code = (err as any)?.code;
  const message = (err as any)?.message;
  if (typeof code !== 'string') return null;
  switch (code) {
    case 'USER_CANCELED':
      return new VaultError('VAULT_ERROR_USER_CANCELED', message ?? code);
    case 'KEY_INVALIDATED':
      return new VaultError('VAULT_ERROR_KEY_INVALIDATED', message ?? code);
    case 'BIOMETRY_UNAVAILABLE':
    case 'BIOMETRY_NOT_ENROLLED':
    case 'BIOMETRICS_UNAVAILABLE':
    case 'BIOMETRICS_NOT_ENROLLED':
      return new VaultError('VAULT_ERROR_BIOMETRICS_UNAVAILABLE', message ?? code);
    case 'NOT_FOUND':
      return new VaultError('VAULT_ERROR_NOT_INITIALIZED', message ?? code);
    case 'BIOMETRY_LOCKOUT':
    case 'BIOMETRY_LOCKOUT_PERMANENT':
      return new VaultError('VAULT_ERROR_BIOMETRY_LOCKOUT', message ?? code);
    case 'AUTH_FAILED':
    case 'VAULT_ERROR':
      return new VaultError('VAULT_ERROR', message ?? code);
    default:
      return null;
  }
}

/**
 * Biometric-backed `IdentityVault` implementation.
 *
 * Construct with zero arguments for production use; pass test overrides
 * for unit tests. A single instance is expected per app process — it
 * manages in-memory material that must be discarded on teardown/lock.
 */
export class BiometricVault
  implements IdentityVault<{ InitializeResult: string }>
{
  private readonly _native: typeof NativeBiometricVault;
  private readonly _secureStorage?: SecureStorageLike;
  private readonly _cryptoApi: NonNullable<BiometricVaultOptions['cryptoApi']>;
  private readonly _didFactory: (args: {
    rootHdKey: any;
    dwnEndpoints?: string[];
  }) => Promise<BearerDid>;
  private readonly _unlockPrompt: typeof DEFAULT_UNLOCK_PROMPT;
  private readonly _provisionPrompt: typeof DEFAULT_PROVISION_PROMPT;

  // In-memory secret bytes (undefined when locked).
  private _secretBytes: Uint8Array | undefined;
  private _rootSeed: Uint8Array | undefined;
  private _rootHdKey: any | undefined;
  private _bearerDid: BearerDid | undefined;
  private _contentEncryptionKey: Uint8Array | undefined;

  private _biometricState: BiometricState = 'unknown';
  private _lastBackup: string | null = null;
  private _lastRestore: string | null = null;

  // Memoized in-flight promises so concurrent initialize()/unlock() calls
  // serialize through a single native invocation.
  private _pendingInitialize: Promise<string> | undefined;
  private _pendingUnlock: Promise<void> | undefined;

  constructor(options: BiometricVaultOptions = {}) {
    this._native = options.biometricVault ?? NativeBiometricVault;
    this._secureStorage = options.secureStorage;
    const cryptoApi = (options.cryptoApi ??
      new AgentCryptoApi()) as NonNullable<BiometricVaultOptions['cryptoApi']>;
    this._cryptoApi = cryptoApi;
    this._didFactory =
      options.didFactory ??
      (async ({ rootHdKey, dwnEndpoints }) =>
        defaultDidFactory({ rootHdKey, dwnEndpoints, cryptoApi }));
    this._unlockPrompt = options.unlockPrompt ?? DEFAULT_UNLOCK_PROMPT;
    this._provisionPrompt = options.provisionPrompt ?? DEFAULT_PROVISION_PROMPT;
  }

  async isInitialized(): Promise<boolean> {
    if (this._secretBytes && this._bearerDid) {
      return true;
    }
    try {
      const hasNative = await this._native.hasSecret(WALLET_ROOT_KEY_ALIAS);
      if (hasNative) return true;
    } catch {
      // Fall through to storage check.
    }
    if (this._secureStorage) {
      try {
        const persisted = await this._secureStorage.get(INITIALIZED_STORAGE_KEY);
        if (persisted === 'true') return true;
      } catch {
        // Ignore storage errors — treat as uninitialized.
      }
    }
    return false;
  }

  isLocked(): boolean {
    return !this._secretBytes || !this._bearerDid || !this._contentEncryptionKey;
  }

  // ---------------------------------------------------------------------
  // Initialize
  // ---------------------------------------------------------------------

  async initialize(params: {
    password?: string;
    recoveryPhrase?: string;
    dwnEndpoints?: string[];
  } = {}): Promise<string> {
    if (this._pendingInitialize) {
      return this._pendingInitialize;
    }
    const task = this._doInitialize(params);
    this._pendingInitialize = task;
    try {
      return await task;
    } finally {
      this._pendingInitialize = undefined;
    }
  }

  private async _doInitialize(params: {
    recoveryPhrase?: string;
    dwnEndpoints?: string[];
  }): Promise<string> {
    // 1. Refuse to overwrite a pre-existing native secret.
    let hasExisting = false;
    try {
      hasExisting = await this._native.hasSecret(WALLET_ROOT_KEY_ALIAS);
    } catch {
      // Defensive: treat native errors here as "unknown" and let
      // generateAndStoreSecret() surface the true cause.
      hasExisting = false;
    }
    if (hasExisting) {
      throw new VaultError(
        'VAULT_ERROR_ALREADY_INITIALIZED',
        'Biometric vault has already been initialized',
      );
    }

    // 2. Derive the canonical 32 bytes of wallet entropy ENTIRELY in JS
    //    before touching the native layer. On a restore flow we use the
    //    user-supplied recovery phrase so the resulting secret
    //    deterministically round-trips to the same mnemonic. On a fresh
    //    install we generate 32 bytes via WebCrypto. Either way the
    //    bytes are captured in a local variable so we never need to
    //    biometric-read them back through `getSecret()` during
    //    provisioning — the second prompt that used to fire here has
    //    been eliminated.
    let entropy: Uint8Array;
    if (params.recoveryPhrase) {
      const trimmed = params.recoveryPhrase.trim();
      if (!validateMnemonic(trimmed, wordlist)) {
        throw new VaultError(
          'VAULT_ERROR',
          'Invalid recovery phrase provided to BiometricVault.initialize()',
        );
      }
      entropy = mnemonicToEntropy(trimmed, wordlist);
      if (entropy.length !== 32) {
        throw new VaultError(
          'VAULT_ERROR',
          `Expected 32 bytes of entropy from recovery phrase, got ${entropy.length}`,
        );
      }
    } else {
      entropy = generateWalletSecretBytes();
    }

    // 3. Hand the already-derived bytes to the native module so it
    //    provisions the biometric-gated secret with EXACTLY the bytes
    //    we derived above. If this call fails (the native side was
    //    unable to create the keystore/keychain entry) there is nothing
    //    to roll back — no secret ever landed on disk.
    try {
      await this._native.generateAndStoreSecret(WALLET_ROOT_KEY_ALIAS, {
        requireBiometrics: true,
        invalidateOnEnrollmentChange: true,
        secretHex: bytesToHex(entropy),
      });
    } catch (err) {
      const mapped = mapNativeErrorToVaultError(err);
      if (mapped?.code === 'VAULT_ERROR_KEY_INVALIDATED') {
        this._biometricState = 'invalidated';
        await this._persistBiometricState('invalidated');
      }
      // Zero the derived entropy — it never landed on-device but may
      // still be in JS memory.
      zeroBytes(entropy);
      this._clearInMemoryState();
      throw mapped ?? err;
    }

    // 4. Derive the HD seed, mnemonic, and BearerDid from the same bytes
    //    we just handed to native. If any of these steps throw AFTER the
    //    native provisioning call already succeeded, we MUST roll back
    //    the orphan native secret via `deleteSecret()` before re-throwing
    //    so `isInitialized()` correctly reports `false` afterwards. Per
    //    VAL-VAULT-027 (and the underlying issue requirement — "the user
    //    should not be forced through setup repeatedly if vault
    //    initialization partially fails"), leaving the native secret
    //    behind would trap the user in an unusable state on the next
    //    launch because `hasSecret()` would return `true` but unlock
    //    would fail to re-derive anything useful. Rollback is best-effort
    //    — if `deleteSecret()` itself rejects we log a warning and still
    //    surface the ORIGINAL derivation error so the caller sees the
    //    real root cause.
    try {
      const mnemonic = entropyToMnemonic(entropy, wordlist);
      if (!validateMnemonic(mnemonic, wordlist)) {
        throw new VaultError('VAULT_ERROR', 'Derived mnemonic failed validation');
      }
      const rootSeed = await mnemonicToSeed(mnemonic);
      const rootHdKey = HDKey.fromMasterSeed(rootSeed);
      const bearerDid = await this._didFactory({
        rootHdKey,
        dwnEndpoints: params.dwnEndpoints,
      });
      const cek = await deriveContentEncryptionKey(rootHdKey);

      // 5. Commit in-memory state only after every step succeeded.
      this._secretBytes = entropy;
      this._rootSeed = rootSeed;
      this._rootHdKey = rootHdKey;
      this._bearerDid = bearerDid;
      this._contentEncryptionKey = cek;
      this._biometricState = 'ready';

      if (this._secureStorage) {
        try {
          await this._secureStorage.set(INITIALIZED_STORAGE_KEY, 'true');
          await this._secureStorage.set(BIOMETRIC_STATE_STORAGE_KEY, 'ready');
        } catch {
          // SecureStorage is optional — non-fatal if it errors.
        }
      }

      return mnemonic;
    } catch (err) {
      // Local derivation failed AFTER the native provisioning call
      // succeeded. Best-effort roll back the orphan native secret so
      // `isInitialized()` returns false and the user can retry
      // first-launch setup cleanly instead of being trapped in an
      // "already-initialized but unusable" state.
      try {
        await this._native.deleteSecret(WALLET_ROOT_KEY_ALIAS);
      } catch (deleteErr) {
        // Rollback itself failed — surface a warning but still throw
        // the ORIGINAL derivation error below so the caller sees the
        // real root cause rather than a secondary rollback failure.
         
        console.warn(
          '[BiometricVault] Failed to roll back native secret after partial init failure',
          deleteErr,
        );
      }
      // Zero the in-memory entropy and clear any partially-committed
      // derived state. We intentionally do NOT persist
      // `INITIALIZED_STORAGE_KEY` or `BIOMETRIC_STATE_STORAGE_KEY`
      // here — persistence only happens on the success path above.
      zeroBytes(entropy);
      this._clearInMemoryState();
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Unlock
  // ---------------------------------------------------------------------

  async unlock(_params: { password?: string } = {}): Promise<void> {
    if (this._pendingUnlock) {
      return this._pendingUnlock;
    }
    const task = this._doUnlock();
    this._pendingUnlock = task;
    try {
      return await task;
    } finally {
      this._pendingUnlock = undefined;
    }
  }

  private async _doUnlock(): Promise<void> {
    // 1. Fast-fail when there is no provisioned secret.
    let hasExisting = false;
    try {
      hasExisting = await this._native.hasSecret(WALLET_ROOT_KEY_ALIAS);
    } catch {
      hasExisting = false;
    }
    if (!hasExisting) {
      throw new VaultError(
        'VAULT_ERROR_NOT_INITIALIZED',
        'Biometric vault has not been initialized',
      );
    }

    // 2. Prompt biometrics and retrieve the secret bytes.
    let secretHex: string;
    try {
      secretHex = await this._native.getSecret(
        WALLET_ROOT_KEY_ALIAS,
        this._unlockPrompt,
      );
    } catch (err) {
      const mapped = mapNativeErrorToVaultError(err);
      if (mapped?.code === 'VAULT_ERROR_KEY_INVALIDATED') {
        this._biometricState = 'invalidated';
        await this._persistBiometricState('invalidated');
      }
      throw mapped ?? err;
    }

    // 3. Rebuild derived state.
    const secretBytes = hexToBytes(secretHex);
    if (secretBytes.length !== 32) {
      throw new VaultError(
        'VAULT_ERROR',
        `Expected 32-byte native secret, got ${secretBytes.length}`,
      );
    }
    const mnemonic = entropyToMnemonic(secretBytes, wordlist);
    const rootSeed = await mnemonicToSeed(mnemonic);
    const rootHdKey = HDKey.fromMasterSeed(rootSeed);
    const bearerDid = await this._didFactory({ rootHdKey });
    const cek = await deriveContentEncryptionKey(rootHdKey);

    this._secretBytes = secretBytes;
    this._rootSeed = rootSeed;
    this._rootHdKey = rootHdKey;
    this._bearerDid = bearerDid;
    this._contentEncryptionKey = cek;
    this._biometricState = 'ready';
  }

  // ---------------------------------------------------------------------
  // Lock / accessors
  // ---------------------------------------------------------------------

  async lock(): Promise<void> {
    // Clear in-memory state. We intentionally do NOT call
    // `NativeBiometricVault.deleteSecret` — the native entry must
    // survive so subsequent `unlock()` calls prompt biometrics instead
    // of re-provisioning the vault.
    this._clearInMemoryState();
  }

  /**
   * Wipe the biometric-gated native secret and all in-memory / persisted
   * vault state. Idempotent — callable repeatedly even after the secret is
   * already gone. Callers use this as part of "Reset wallet" flows and
   * after recovery-phrase restore to re-arm biometric protection.
   *
   * Intentionally does NOT throw when the native secret is absent — the
   * goal is to leave the vault in a clean, uninitialized state regardless
   * of the starting point.
   */
  async reset(): Promise<void> {
    // 1. Delete the biometric-gated native secret. Best-effort — if
    //    deletion fails we still clear in-memory state below so the
    //    caller isn't stuck holding stale data.
    try {
      await this._native.deleteSecret(WALLET_ROOT_KEY_ALIAS);
    } catch {
      // Native modules treat missing-alias deletes as success; any other
      // error is logged by the native layer. Swallow here so reset stays
      // idempotent.
    }

    // 2. Clear SecureStorage flags so `isInitialized()` correctly
    //    reports `false` on the next call and so a future app launch
    //    cannot spuriously restore a stale `invalidated` biometric state.
    if (this._secureStorage) {
      try {
        await this._secureStorage.remove(INITIALIZED_STORAGE_KEY);
      } catch {
        // best-effort
      }
      try {
        await this._secureStorage.remove(BIOMETRIC_STATE_STORAGE_KEY);
      } catch {
        // best-effort
      }
    }

    // 3. Clear in-memory derived material + reset the biometric state
    //    machine to "unknown" so the next hydrate / initialize starts
    //    fresh.
    this._clearInMemoryState();
    this._biometricState = 'unknown';
    this._lastBackup = null;
    this._lastRestore = null;
  }

  async getDid(): Promise<BearerDid> {
    if (this.isLocked() || !this._bearerDid) {
      throw new VaultError('VAULT_ERROR_LOCKED', 'Vault is locked');
    }
    return this._bearerDid;
  }

  async getStatus(): Promise<BiometricVaultStatus> {
    const initialized = await this.isInitialized();
    let biometricState: BiometricState = this._biometricState;
    if (biometricState === 'unknown' && this._secureStorage) {
      try {
        const stored = await this._secureStorage.get(BIOMETRIC_STATE_STORAGE_KEY);
        if (
          stored === 'ready' ||
          stored === 'invalidated' ||
          stored === 'unavailable'
        ) {
          biometricState = stored;
          this._biometricState = stored;
        }
      } catch {
        // ignore
      }
    }
    return {
      initialized,
      lastBackup: this._lastBackup,
      lastRestore: this._lastRestore,
      biometricState,
    };
  }

  // ---------------------------------------------------------------------
  // Password-based stubs (not applicable to a biometric-first vault)
  // ---------------------------------------------------------------------

  async changePassword(_params: {
    oldPassword: string;
    newPassword: string;
  }): Promise<void> {
    throw new VaultError(
      'VAULT_ERROR_UNSUPPORTED',
      'BiometricVault does not support password-based auth',
    );
  }

  async backup(): Promise<IdentityVaultBackup> {
    if (this.isLocked()) {
      throw new VaultError('VAULT_ERROR_LOCKED', 'Vault is locked');
    }
    throw new VaultError(
      'VAULT_ERROR_UNSUPPORTED',
      'BiometricVault backup is handled via recovery phrase, not JWE export',
    );
  }

  async restore(_params: {
    backup: IdentityVaultBackup;
    password: string;
  }): Promise<void> {
    throw new VaultError(
      'VAULT_ERROR_UNSUPPORTED',
      'BiometricVault restore is handled via recovery-phrase re-seal, not JWE import',
    );
  }

  // ---------------------------------------------------------------------
  // Data encryption
  // ---------------------------------------------------------------------

  async encryptData({ plaintext }: { plaintext: Uint8Array }): Promise<string> {
    if (this.isLocked() || !this._contentEncryptionKey) {
      throw new VaultError('VAULT_ERROR_LOCKED', 'Vault is locked');
    }
    return aesGcmEncrypt(this._contentEncryptionKey, plaintext);
  }

  async decryptData({ jwe }: { jwe: string }): Promise<Uint8Array> {
    if (this.isLocked() || !this._contentEncryptionKey) {
      throw new VaultError('VAULT_ERROR_LOCKED', 'Vault is locked');
    }
    return aesGcmDecrypt(this._contentEncryptionKey, jwe);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private _clearInMemoryState() {
    zeroBytes(this._secretBytes);
    zeroBytes(this._rootSeed);
    zeroBytes(this._contentEncryptionKey);
    this._secretBytes = undefined;
    this._rootSeed = undefined;
    this._rootHdKey = undefined;
    this._bearerDid = undefined;
    this._contentEncryptionKey = undefined;
  }

  private async _persistBiometricState(state: BiometricState): Promise<void> {
    if (!this._secureStorage) return;
    try {
      await this._secureStorage.set(BIOMETRIC_STATE_STORAGE_KEY, state);
    } catch {
      // best-effort
    }
  }
}
