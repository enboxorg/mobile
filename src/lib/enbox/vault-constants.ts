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
