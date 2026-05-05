import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  isBiometricAvailable(): Promise<{
    available: boolean;
    enrolled: boolean;
    type: 'faceID' | 'touchID' | 'fingerprint' | 'face' | 'none';
    reason?: string;
  }>;
  /**
   * Provision a new biometric-gated secret under `keyAlias`.
   *
   * **Non-destructive contract (VAL-VAULT-030)**: this method MUST
   * reject with `VAULT_ERROR_ALREADY_INITIALIZED` if a secret already
   * exists under `keyAlias`. It is NOT an upsert. Callers that intend
   * to overwrite an existing secret MUST first call `deleteSecret(...)`
   * explicitly — the surfaced error makes that intent visible to
   * reviewers and prevents an in-flight setup cancellation (or an
   * `add` failure on iOS, or a `BiometricPrompt` cancellation on
   * Android) from irreversibly destroying a working wallet by way of
   * the silent delete-before-write pattern.
   *
   * Implementations may skip the existence check only when their own
   * provisioning path is fully reversible (today neither iOS nor
   * Android can offer that — Keychain and Keystore both lack a
   * compare-and-swap primitive — so both implementations enforce the
   * pre-check).
   *
   * **Per-alias serialization contract (round-15 F3)**: native
   * implementations MUST serialize concurrent
   * `generateAndStoreSecret` / `deleteSecret` calls on the SAME
   * alias. A second concurrent call for an alias whose
   * provisioning / deletion is still in flight MUST fail-fast with
   * `VAULT_ERROR_OPERATION_IN_PROGRESS` rather than racing through
   * the destructive `delete-then-create` window. Cross-alias calls
   * remain parallel.
   *
   * iOS satisfies this for free via the module-level serial dispatch
   * queue (`_keychainQueue`); Android uses a per-alias membership
   * lock at the companion-object level. The JS layer
   * (`BiometricSetupScreen`) also has a synchronous tap-guard, but
   * the TurboModule contract is public — deep links, attached
   * debuggers, dev tools, and future native consumers all reach the
   * module directly, and JS-side serialization cannot guarantee
   * exclusivity across multiple `BiometricVault` instances within
   * the same RN process. Native serialization is the only way to
   * guarantee the contract end-to-end.
   */
  generateAndStoreSecret(
    keyAlias: string,
    options: {
      requireBiometrics: boolean;
      invalidateOnEnrollmentChange?: boolean;
      /**
       * Optional caller-provided 32-byte wallet secret, lower-case hex
       * (length 64). When supplied, the native module MUST store these
       * exact bytes under `keyAlias` and MUST NOT generate new entropy.
       * When omitted, the native module generates fresh 32 random bytes
       * itself (legacy behaviour). Callers pass this so the JS layer
       * can derive the HD seed / mnemonic from the same bytes without
       * a follow-up biometric read of the stored secret.
       */
      secretHex?: string;
      /**
       * Optional biometric-prompt copy used during provisioning.
       *
       * Round-9 F3 contract parity (VAL-VAULT-033). Android's
       * `Cipher.init(ENCRYPT_MODE)` for a biometric-bound Keystore
       * key naturally fires a `BiometricPrompt.authenticate()` with
       * THIS title/message/cancel as part of provisioning, but iOS's
       * `SecItemAdd` for a Keychain item with a `BiometryCurrentSet`
       * ACL does NOT prompt by itself — the iOS implementation
       * therefore drives an explicit `LAContext.evaluatePolicy(...)`
       * BEFORE the `SecItemAdd` so both platforms gate provisioning
       * on a fresh, user-present biometric authentication using the
       * same caller-controlled copy. Tests / dev builds that have no
       * UI thread (`currentActivity == null` on Android, missing
       * `LAContext` on iOS) MUST still reject deterministically
       * rather than silently provisioning under no biometric gate.
       */
      promptTitle?: string;
      promptMessage?: string;
      promptCancel?: string;
      promptSubtitle?: string;
    },
  ): Promise<void>;
  getSecret(
    keyAlias: string,
    prompt: {
      promptTitle: string;
      promptMessage: string;
      promptCancel: string;
      promptSubtitle?: string;
    },
  ): Promise<string>;
  hasSecret(keyAlias: string): Promise<boolean>;
  deleteSecret(keyAlias: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeBiometricVault');
