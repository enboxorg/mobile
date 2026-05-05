/**
 * Pure-data constants shared by `biometric-vault.ts`, `agent-store.ts`,
 * and `session-store.ts`.
 *
 * This module intentionally contains NO runtime imports — neither
 * static nor dynamic — so it can be loaded from any Jest context
 * (including `session-store.test.ts`) without pulling in the ESM-only
 * `@enbox/agent` runtime that `biometric-vault.ts` depends on.
 *
 * Before this module existed the two constants below were duplicated
 * across `biometric-vault.ts` and `session-store.ts`, and
 * `agent-store.reset()` used a dynamic `require('@/features/session/session-store')`
 * to avoid a circular-import chain through `@enbox/agent`. Centralizing
 * the pure data here lets every consumer use a normal static import.
 *
 * Guard rail: DO NOT add runtime imports to this file. If you need a
 * constant that depends on a runtime module, put it in that module
 * instead. The whole point of this file is to be a leaf in the module
 * graph.
 */

/** Keychain/Keystore alias that holds the wallet's root biometric-gated secret. */
export const WALLET_ROOT_KEY_ALIAS = 'enbox.wallet.root';

/**
 * Well-known `@enbox/auth` SecureStorage key recording whether the
 * vault has ever been initialized. Complements
 * `NativeBiometricVault.hasSecret` so `BiometricVault.isInitialized()`
 * has a reliable answer even in the corner case where the native
 * module is momentarily unreachable (e.g. during app cold-start before
 * the native bridge has finished initializing).
 */
export const INITIALIZED_STORAGE_KEY = 'enbox.vault.initialized';

/**
 * Well-known SecureStorage key holding the last observed biometric
 * state so the app can restore the `invalidated` / `ready` gate across
 * app restarts without re-prompting.
 */
export const BIOMETRIC_STATE_STORAGE_KEY = 'enbox.vault.biometric-state';

/**
 * HD derivation paths for the three identity-account keys that the
 * BiometricVault's `defaultDidFactory` feeds into
 * `DeterministicKeyGenerator` before calling `DidDht.create`. The
 * ordering is load-bearing — predefined keys are consumed in order, so
 * `[0]` becomes the identity verification method (`Ed25519`), `[1]`
 * the signing method (`Ed25519`), and `[2]` the encryption method
 * (`X25519`). Mirrors the recipe baked into `HdIdentityVault` upstream
 * so a mnemonic derived here re-derives the same DID in any other
 * `@enbox/agent` consumer.
 *
 * This constant is the single source of truth for the paths: both
 * `biometric-vault.ts` (production derivation) and the determinism
 * snapshot test import it, so the test cannot drift from the runtime
 * recipe. Reordering or mutating this tuple is a BREAKING change to
 * the DID derivation.
 */
export const IDENTITY_DERIVATION_PATHS: readonly [string, string, string] = [
  "m/44'/0'/1708523827'/0'/0'", // identity verification method (Ed25519)
  "m/44'/0'/1708523827'/0'/1'", // signing verification method (Ed25519)
  "m/44'/0'/1708523827'/0'/2'", // encryption verification method (X25519)
] as const;

/**
 * HD derivation path for the content-encryption key bound to the root
 * HD seed. Matches the path `HdIdentityVault` uses for its vault CEK so
 * the CEK rides the same deterministic chain as the DID. Kept separate
 * from the identity paths because it is NOT fed through
 * `DeterministicKeyGenerator`.
 */
export const VAULT_CEK_DERIVATION_PATH = "m/44'/0'/0'/0'/0'";
