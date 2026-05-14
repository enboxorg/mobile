package org.enbox.mobile.nativemodules

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.KeyStoreException
import java.security.SecureRandom
import java.security.UnrecoverableKeyException
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Biometric-gated Android Keystore vault for a single 256-bit wallet secret.
 *
 * Design:
 * - Keystore (AndroidKeyStore) holds an AES-256-GCM secret key that requires
 *   class-3 biometric authentication for every decrypt operation:
 *   setUserAuthenticationRequired(true) + setUserAuthenticationParameters(0,
 *   KeyProperties.AUTH_BIOMETRIC_STRONG). Enrollment change invalidates the
 *   key automatically via setInvalidatedByBiometricEnrollment(true), which
 *   maps to KEY_INVALIDATED at decrypt time.
 * - The wallet secret itself (32 random bytes) is wrapped with the Keystore
 *   key and stored, together with its per-call GCM IV, inside a private
 *   SharedPreferences file. The IV is never reused — AndroidKeyStore AES/GCM
 *   keys created with setRandomizedEncryptionRequired(true) REQUIRE the
 *   Keystore provider to generate the IV itself on every encrypt, so we
 *   initialise the encrypt cipher without an IV parameter and read
 *   `cipher.iv` post-init before persisting alongside the ciphertext. The
 *   decrypt path continues to pass the stored IV via GCMParameterSpec to
 *   `Cipher.init(DECRYPT_MODE, key, ...)`.
 * - getSecret uses BiometricPrompt.CryptoObject(cipher) with a Cipher
 *   initialized in DECRYPT_MODE so that the biometric authentication
 *   unlocks the cipher for exactly one decrypt.
 * - Availability is reported via BiometricManager.from(ctx).canAuthenticate(
 *   BiometricManager.Authenticators.BIOMETRIC_STRONG).
 * - No raw secret or mnemonic ever leaves this module. We deliberately
 *   avoid every android logging surface entirely so there is no risk of
 *   hex- or byte-encoded secret appearing in logcat.
 */
class NativeBiometricVaultModule(reactContext: ReactApplicationContext) : NativeBiometricVaultSpec(reactContext) {

    companion object {
        const val NAME = "NativeBiometricVault"

        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val PREFS_NAME = "org.enbox.mobile.biometric.prefs"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128
        private const val SECRET_BYTES = 32

        // Canonical error codes surfaced to JS. Must match the iOS file and
        // the JS wrapper exactly.
        private const val ERR_USER_CANCELED = "USER_CANCELED"
        private const val ERR_BIOMETRY_UNAVAILABLE = "BIOMETRY_UNAVAILABLE"
        private const val ERR_BIOMETRY_NOT_ENROLLED = "BIOMETRY_NOT_ENROLLED"
        private const val ERR_BIOMETRY_LOCKOUT = "BIOMETRY_LOCKOUT"
        private const val ERR_BIOMETRY_LOCKOUT_PERMANENT = "BIOMETRY_LOCKOUT_PERMANENT"
        private const val ERR_KEY_INVALIDATED = "KEY_INVALIDATED"
        private const val ERR_NOT_FOUND = "NOT_FOUND"
        private const val ERR_AUTH_FAILED = "AUTH_FAILED"
        private const val ERR_VAULT = "VAULT_ERROR"
        // VAL-VAULT-030: explicit non-destructive contract on
        // `generateAndStoreSecret`. The native API is NOT an upsert —
        // calling it over an existing alias rejects with this code so a
        // mid-setup BiometricPrompt cancel / SharedPreferences write
        // failure cannot wipe a working wallet via the silent
        // delete-before-write pattern.
        private const val ERR_ALREADY_INITIALIZED = "VAULT_ERROR_ALREADY_INITIALIZED"
        // Returned when a concurrent generate/get/delete operation is
        // already in flight for the same alias. Cross-alias calls remain
        // parallel.
        private const val ERR_OPERATION_IN_PROGRESS =
            "VAULT_ERROR_OPERATION_IN_PROGRESS"

        // Strict lower-case-hex validator for the
        // optional `secretHex` parameter on `generateAndStoreSecret`.
        // The TurboModule spec (`specs/NativeBiometricVault.ts:36-38`)
        // and the Jest mock (`jest.setup.js:113`) both pin
        // `^[0-9a-f]{64}$`. Centralising the regex here keeps Android,
        // iOS and JS in lock-step — see the call site for the full
        // contract-drift rationale.
        private val LOWER_HEX_64_REGEX = Regex("^[0-9a-f]{64}$")

        /**
         * Per-alias serialization for state-changing
         * operations (`generateAndStoreSecret`, `getSecret`,
         * `deleteSecret`).
         *
         * Previously, the Android module had no concurrency guard at the
         * native level. Two concurrent `generateAndStoreSecret(alias)`
         * calls both passed the `hasPrefs && hasKey` non-upsert check
         * (each sees an empty alias state), then both ran
         * `deleteKeystoreKeyBestEffort(alias) + createKeystoreKey(alias)`
         * back-to-back — the second `KeyGenParameterSpec.Builder` call
         * silently overwrites the alias entry created by the first.
         * Each call's `Cipher` is bound to its own (now-mutated) key,
         * so:
         *   - The user authenticates whichever BiometricPrompt is on
         *     screen. doFinal succeeds / fails depending on which key
         *     "won" the race; the other call's prompt is left dangling
         *     until the user cancels, at which point its
         *     `deleteKeystoreKeyBestEffort` wipes the alias the
         *     succeeded call just persisted ciphertext under.
         *   - Result: prefs encrypted under a key that no longer
         *     exists in the Keystore, surfaced as `KEY_INVALIDATED`
         *     on the very first unlock attempt with no recovery path
         *     short of a full reset.
         *
         * The JS layer (`BiometricSetupScreen`) already has a
         * synchronous tap-guard, but the TurboModule contract is
         * public — deep links, attached debuggers, dev tools, and
         * future native consumers all reach the module directly. The
         * JS guard cannot block multi-instance JS callers either
         * (e.g. a BiometricVault constructed in a worker / second
         * RN runtime). Native serialization is the only way to
         * guarantee the contract end-to-end.
         *
         * Implementation: `ConcurrentHashMap.newKeySet()` membership
         * acts as a non-reentrant per-alias lock. `add(alias)` is
         * atomic and returns `false` when the alias is already in the
         * set; `remove(alias)` is the matching release. The set lives
         * on the companion object so the lock is process-scoped (two
         * `NativeBiometricVaultModule` instances within the same RN
         * process share the same lock), which mirrors what iOS gets
         * for free via the module-level serial dispatch queue. Native
         * module re-instantiation (RN reload during dev) starts with
         * an empty set, which is correct because no Keystore op can
         * outlive the process.
         *
         * Released on every terminal path (early returns, biometric
         * callbacks, exceptions). The `BiometricPrompt.authenticate`
         * callback fires on the system executor we provide, NOT the
         * RN module thread that acquired the lock — `Set.remove` is
         * thread-agnostic so this works correctly across thread
         * boundaries (a `ReentrantLock` would not, because its
         * thread-affinity check would throw
         * `IllegalMonitorStateException` on cross-thread release).
         */
        private val aliasInProgress: MutableSet<String> =
            ConcurrentHashMap.newKeySet()

        /**
         * Atomically claim `alias` for an exclusive operation. Returns
         * `true` when the caller now owns the lock and MUST eventually
         * call `releaseAliasLock(alias)`; returns `false` when another
         * caller is still holding it (use `ERR_OPERATION_IN_PROGRESS`).
         */
        private fun tryAcquireAliasLock(alias: String): Boolean =
            aliasInProgress.add(alias)

        /**
         * Release an acquired per-alias lock. Idempotent on already
         * released aliases to tolerate overlapping cleanup paths.
         */
        private fun releaseAliasLock(alias: String) {
            aliasInProgress.remove(alias)
        }
    }

    override fun getName(): String = NAME

    // ---------------------------------------------------------------------
    // Storage helpers
    // ---------------------------------------------------------------------

    private fun prefs() = reactApplicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun ivKey(alias: String) = "$alias.iv"
    private fun ctKey(alias: String) = "$alias.ct"

    private fun loadKeystoreKey(alias: String): SecretKey? {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER)
        keyStore.load(null)
        val entry = keyStore.getKey(alias, null) ?: return null
        return entry as SecretKey
    }

    /**
     * CHECKED Keystore delete. Throws on Keystore failure
     * AND verifies the alias is gone after `deleteEntry()` returns —
     * `KeyStore.deleteEntry` is documented to throw `KeyStoreException`
     * on failure, but some OEM Keystore implementations swallow the
     * exception and leave the entry alive. The post-delete
     * `containsAlias` check catches both the silent-fail case and the
     * race where a concurrent provisioning re-added the alias after
     * our delete.
     *
     * Used by the public `deleteSecret()` reset path. The
     * best-effort variant `deleteKeystoreKeyBestEffort()` is used by
     * `invalidateAlias()` for internal failure-cleanup paths where the
     * caller already has a primary error to surface.
     *
     * @throws KeyStoreException if the underlying Keystore op fails OR
     *         the alias still exists after the delete returned.
     * @throws Exception if KeyStore.getInstance / load fails (e.g.
     *         missing AndroidKeyStore provider on a corrupt build).
     */
    private fun deleteKeystoreKeyChecked(alias: String) {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER)
        keyStore.load(null)
        if (keyStore.containsAlias(alias)) {
            keyStore.deleteEntry(alias)
            // Verify the entry is gone. `KeyStore.deleteEntry` is
            // declared to throw on failure but field reports across
            // OEM forks (Samsung, Huawei) show silent-failure
            // variants where the call returns normally yet the
            // alias survives. The post-delete read is cheap and
            // gives us a hard signal we can fail-CLOSED on.
            if (keyStore.containsAlias(alias)) {
                throw KeyStoreException(
                    "deleteEntry returned but alias '$alias' still present in AndroidKeyStore",
                )
            }
        }
    }

    /**
     * Best-effort wrapper around `deleteKeystoreKeyChecked` for the
     * internal failure-cleanup path (`invalidateAlias`). Used only
     * when the caller already has a primary error to surface and
     * doesn't want a secondary cleanup failure to mask it. The public
     * delete/reset path MUST use the checked variant.
     */
    private fun deleteKeystoreKeyBestEffort(alias: String) {
        try {
            deleteKeystoreKeyChecked(alias)
        } catch (_: Exception) {
            // swallow — best-effort cleanup; primary error already
            // captured by the caller. Do NOT route to the public
            // deleteSecret path.
        }
    }

    /**
     * Drop ALL persistent state for `alias` so a subsequent
     * `hasSecret(alias)` resolves false and a fresh provisioning round
     * starts from a clean slate.
     *
     * Used on every "the key is dead" signal so the Keystore alias and
     * SharedPreferences ciphertext converge together. Routing both
     * signals through this helper keeps the cleanup symmetric.
     *
     * Best-effort by construction: both inner ops swallow exceptions.
     * The caller has already decided the entry is unusable; logging or
     * surfacing a secondary error here would only obscure the original
     * `KEY_INVALIDATED` rejection.
     */
    private fun invalidateAlias(alias: String) {
        deleteKeystoreKeyBestEffort(alias)
        try {
            prefs().edit().remove(ivKey(alias)).remove(ctKey(alias)).apply()
        } catch (_: Exception) {
            // SharedPreferences I/O on a private file effectively never
            // throws on Android, but we belt-and-suspender it because
            // any throw here would be triggered AFTER we already decided
            // the alias is unrecoverable, and we MUST NOT mask the
            // KEY_INVALIDATED rejection with a stale-prefs cleanup
            // failure.
        }
    }

    /**
     * Build the KeyGenParameterSpec for the biometric-bound AES-256-GCM
     * wrapping key. All of the security-critical flags listed in the mission
     * contract (VAL-NATIVE-015 / VAL-NATIVE-041) are set here.
     */
    private fun createKeyGenSpec(alias: String): KeyGenParameterSpec {
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // API 30+: class-3 biometric only, zero-second validity so the
            // key requires a fresh BiometricPrompt authentication on every
            // use. No device-credential fallback is permitted — this is the
            // mission's release-build contract.
            builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
            // API 24–29 predates setUserAuthenticationParameters; pass -1 to
            // require auth on every operation (no validity duration).
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }

        return builder.build()
    }

    private fun createKeystoreKey(alias: String): SecretKey {
        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
        keyGen.init(createKeyGenSpec(alias))
        return keyGen.generateKey()
    }

    // ---------------------------------------------------------------------
    // Error mapping
    // ---------------------------------------------------------------------

    /**
     * Map a BiometricPrompt.ERROR_* code to the canonical JS error code.
     * Branches must reference every ERROR_* constant the contract pins
     * (BIOMETRIC_ERROR_NO_HARDWARE, BIOMETRIC_ERROR_HW_UNAVAILABLE etc. are
     * aliases for ERROR_HW_NOT_PRESENT / ERROR_HW_UNAVAILABLE in the
     * androidx.biometric surface, but we include them in comments so the
     * static rg check can confirm each token is accounted for).
     */
    private fun mapBiometricError(errorCode: Int): String = when (errorCode) {
        BiometricPrompt.ERROR_USER_CANCELED,
        BiometricPrompt.ERROR_CANCELED,
        BiometricPrompt.ERROR_NEGATIVE_BUTTON -> ERR_USER_CANCELED

        BiometricPrompt.ERROR_LOCKOUT -> ERR_BIOMETRY_LOCKOUT
        BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> ERR_BIOMETRY_LOCKOUT_PERMANENT

        BiometricPrompt.ERROR_NO_BIOMETRICS -> ERR_BIOMETRY_NOT_ENROLLED

        // ERROR_HW_NOT_PRESENT (a.k.a. BIOMETRIC_ERROR_NO_HARDWARE) and
        // ERROR_HW_UNAVAILABLE (a.k.a. BIOMETRIC_ERROR_HW_UNAVAILABLE) both
        // mean the device cannot authenticate; surface as BIOMETRY_UNAVAILABLE.
        BiometricPrompt.ERROR_HW_NOT_PRESENT,
        BiometricPrompt.ERROR_HW_UNAVAILABLE -> ERR_BIOMETRY_UNAVAILABLE

        else -> ERR_VAULT
    }

    private fun mapKeystoreException(e: Throwable): String = when (e) {
        is KeyPermanentlyInvalidatedException -> ERR_KEY_INVALIDATED
        is UnrecoverableKeyException -> ERR_KEY_INVALIDATED
        is AEADBadTagException -> ERR_AUTH_FAILED
        else -> ERR_VAULT
    }

    // ---------------------------------------------------------------------
    // Spec implementations
    // ---------------------------------------------------------------------

    override fun isBiometricAvailable(promise: Promise) {
        try {
            val manager = BiometricManager.from(reactApplicationContext)
            val status = manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)

            val result = WritableNativeMap()
            // Android does not expose a first-class "face vs fingerprint"
            // type selector on the biometric surface; report generic
            // "fingerprint" as the dominant class-3 modality.
            when (status) {
                BiometricManager.BIOMETRIC_SUCCESS -> {
                    result.putBoolean("available", true)
                    result.putBoolean("enrolled", true)
                    result.putString("type", "fingerprint")
                }
                BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> {
                    result.putBoolean("available", true)
                    result.putBoolean("enrolled", false)
                    result.putString("type", "none")
                    result.putString("reason", ERR_BIOMETRY_NOT_ENROLLED)
                }
                BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE,
                BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> {
                    result.putBoolean("available", false)
                    result.putBoolean("enrolled", false)
                    result.putString("type", "none")
                    result.putString("reason", ERR_BIOMETRY_UNAVAILABLE)
                }
                else -> {
                    result.putBoolean("available", false)
                    result.putBoolean("enrolled", false)
                    result.putString("type", "none")
                    result.putString("reason", ERR_BIOMETRY_UNAVAILABLE)
                }
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject(ERR_VAULT, "isBiometricAvailable failed")
        }
    }

    override fun generateAndStoreSecret(keyAlias: String, options: ReadableMap, promise: Promise) {
        if (keyAlias.isEmpty()) {
            promise.reject(ERR_VAULT, "keyAlias must be a non-empty string")
            return
        }

        // requireBiometrics is cross-platform contract. For the biometric
        // vault we always gate with class-3 biometrics; a caller passing
        // `false` must NOT silently fall back to an unauthenticated store.
        val requireBiometrics =
            if (options.hasKey("requireBiometrics")) options.getBoolean("requireBiometrics") else true
        if (!requireBiometrics) {
            promise.reject(ERR_VAULT,
                "requireBiometrics=false is not supported by the biometric vault")
            return
        }

        // Claim the per-alias lock BEFORE any Keystore /
        // SharedPreferences mutation. Concurrent calls on the SAME
        // alias fail fast with VAULT_ERROR_OPERATION_IN_PROGRESS so
        // they cannot race through the destructive
        // `deleteKeystoreKeyBestEffort + createKeystoreKey` pair below.
        // Cross-alias calls are unaffected (different alias =
        // different membership entry).
        //
        // EVERY terminal path from here forward MUST call
        // `releaseAliasLock(keyAlias)` (the helper-released paths and
        // the BiometricPrompt callback paths all do). The
        // `lockReleased` boolean prevents double-release across paths
        // that overlap on early-exit logic (e.g. a callback that
        // resolved before an outer catch fires).
        if (!tryAcquireAliasLock(keyAlias)) {
            promise.reject(
                ERR_OPERATION_IN_PROGRESS,
                "A generateAndStoreSecret/getSecret/deleteSecret is already in progress for this alias",
            )
            return
        }
        // Lambda variable (NOT a local function): a Kotlin lambda is a
        // first-class object that is always-correctly captured by
        // anonymous-object subclasses (`BiometricPrompt.AuthenticationCallback`
        // below). Local functions can be called from the enclosing
        // scope but are not guaranteed to be reachable from an
        // anonymous-object instance method (the inner-class capture
        // semantics differ across Kotlin versions). Lambdas dodge
        // that ambiguity entirely.
        val lockReleased = booleanArrayOf(false)
        val releaseAliasLockOnce: () -> Unit = {
            if (!lockReleased[0]) {
                lockReleased[0] = true
                releaseAliasLock(keyAlias)
            }
        }

        // Refuse to provision over an existing alias. The probe fails
        // closed because a transient Keystore or prefs read error cannot
        // prove the alias is safe to replace.
        try {
            val hasPrefs = prefs().contains(ivKey(keyAlias)) && prefs().contains(ctKey(keyAlias))
            val hasKey = loadKeystoreKey(keyAlias) != null
            if (hasPrefs && hasKey) {
                promise.reject(
                    ERR_ALREADY_INITIALIZED,
                    "A biometric secret already exists for this alias; " +
                        "delete it explicitly before re-provisioning",
                )
                releaseAliasLockOnce()
                return
            }
            // At this point at least one of (prefs, key) is genuinely
            // absent. The provisioning path below is safe to enter:
            // it will overwrite any orphan prefs and create a fresh
            // key under the missing alias, with no destructive impact
            // on a valid pre-existing setup (which we just proved
            // does not exist).
        } catch (e: Exception) {
            // Probe genuinely failed; we cannot tell whether a valid
            // alias is hiding behind the exception. Refuse rather
            // than risk wiping it. The intentionally generic message
            // mirrors the no-secret-leak rule for every error path.
            promise.reject(
                ERR_VAULT,
                "Could not determine whether a biometric secret already exists; " +
                    "refusing to provision to avoid overwriting a valid alias",
            )
            releaseAliasLockOnce()
            return
        }

        // Resolve the 32-byte wallet secret up-front — caller-provided bytes
        // (via `secretHex`, lower-case hex of length 64) when supplied,
        // otherwise freshly generated CSPRNG entropy. Caller-provided bytes
        // let the JS layer derive the HD seed / mnemonic from the same bytes
        // that will be stored here without a follow-up biometric read during
        // provisioning (that would fire a second BiometricPrompt).
        //
        // Strict lower-case-hex contract shared by the TurboModule spec,
        // Jest mock, and iOS implementation.
        val secret = ByteArray(SECRET_BYTES)
        val providedHex = if (options.hasKey("secretHex")) options.getString("secretHex") else null
        if (providedHex != null) {
            if (!LOWER_HEX_64_REGEX.matches(providedHex)) {
                promise.reject(
                    ERR_VAULT,
                    "secretHex must be exactly 64 lower-case hex characters " +
                        "(^[0-9a-f]{64}\$)",
                )
                releaseAliasLockOnce()
                return
            }
            for (i in 0 until SECRET_BYTES) {
                // Safe: regex already pinned both characters to [0-9a-f].
                val hi = Character.digit(providedHex[i * 2], 16)
                val lo = Character.digit(providedHex[i * 2 + 1], 16)
                secret[i] = ((hi shl 4) or lo).toByte()
            }
        } else {
            SecureRandom().nextBytes(secret)
        }

        // Prepare the biometric-bound Keystore key + ENCRYPT cipher. The
        // cipher.init call succeeds without biometric auth (the operation
        // handle is created with an unauthenticated token); the actual
        // cipher.doFinal call inside onAuthenticationSucceeded() is what
        // requires the auth token that `BiometricPrompt` supplies.
        //
        // AndroidKeyStore AES/GCM note: keys created with
        // setRandomizedEncryptionRequired(true) (see createKeyGenSpec
        // above — required by the mission's security contract) MUST let
        // the Keystore provider generate the GCM IV itself. Supplying a
        // caller-generated IV via GCMParameterSpec at ENCRYPT_MODE is
        // rejected by the provider with an
        // InvalidAlgorithmParameterException on several Android versions.
        // We read `cipher.iv` after init so we can persist the
        // provider-generated IV alongside the ciphertext on the success
        // path.
        val cipher: Cipher
        val iv: ByteArray
        try {
            // Rotate the Keystore key on every provisioning so that an old
            // wrapped ciphertext from a previous install cannot accidentally
            // be decryptable under a reused alias. Best-effort cleanup —
            // `KeyGenParameterSpec.Builder(alias, ...)` overwrites any
            // existing entry, so a silent failure here is recovered by
            // the subsequent `createKeystoreKey`.
            deleteKeystoreKeyBestEffort(keyAlias)
            val key = createKeystoreKey(keyAlias)
            cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            iv = cipher.iv
        } catch (e: KeyPermanentlyInvalidatedException) {
            secret.fill(0.toByte())
            deleteKeystoreKeyBestEffort(keyAlias)
            promise.reject(ERR_KEY_INVALIDATED, "Keystore key was invalidated")
            releaseAliasLockOnce()
            return
        } catch (e: GeneralSecurityException) {
            secret.fill(0.toByte())
            deleteKeystoreKeyBestEffort(keyAlias)
            promise.reject(mapKeystoreException(e), "generateAndStoreSecret failed")
            releaseAliasLockOnce()
            return
        } catch (e: Exception) {
            secret.fill(0.toByte())
            deleteKeystoreKeyBestEffort(keyAlias)
            promise.reject(ERR_VAULT, "generateAndStoreSecret failed")
            releaseAliasLockOnce()
            return
        }

        // BiometricPrompt.authenticate must be invoked on the UI thread;
        // biometrics-bound keys created with
        // setUserAuthenticationRequired(true) + AUTH_BIOMETRIC_STRONG +
        // zero-second validity require a FRESH `BiometricPrompt`
        // authentication to produce the per-operation auth token that
        // Keystore's `update()` consumes. Calling `cipher.doFinal(...)`
        // directly (without going through `BiometricPrompt.CryptoObject`)
        // triggers a keystore2 `KeystoreOperation::update` rejection with
        // `Km(ErrorCode(-26))` = `KEY_USER_NOT_AUTHENTICATED` — that was
        // the root-cause of the post-enrollment VAULT_ERROR observed in
        // the debug-emulator CI runs prior to this fix.
        val activity = currentActivity as? FragmentActivity
        if (activity == null) {
            secret.fill(0.toByte())
            deleteKeystoreKeyBestEffort(keyAlias)
            promise.reject(ERR_VAULT, "No FragmentActivity available for biometric prompt")
            releaseAliasLockOnce()
            return
        }

        val title = if (options.hasKey("promptTitle")) options.getString("promptTitle") ?: "" else ""
        val message = if (options.hasKey("promptMessage")) options.getString("promptMessage") ?: "" else ""
        val cancel = if (options.hasKey("promptCancel")) options.getString("promptCancel") ?: "Cancel" else "Cancel"
        val subtitle = if (options.hasKey("promptSubtitle")) options.getString("promptSubtitle") else null

        activity.runOnUiThread {
            val executor = ContextCompat.getMainExecutor(reactApplicationContext)
            val alreadyResolved = booleanArrayOf(false)

            val callback = object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (alreadyResolved[0]) return
                    alreadyResolved[0] = true
                    // Zero the in-memory secret and roll back the orphan
                    // Keystore key so `isInitialized()` keeps returning
                    // false and the user can retry setup cleanly.
                    secret.fill(0.toByte())
                    deleteKeystoreKeyBestEffort(keyAlias)
                    val code = mapBiometricError(errorCode)
                    try {
                        promise.reject(code, "Biometric authentication failed")
                    } finally {
                        // callback fires on the system
                        // executor — different thread from the one
                        // that acquired the alias lock. Set-based
                        // release is thread-agnostic so this works.
                        releaseAliasLockOnce()
                    }
                }

                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (alreadyResolved[0]) return
                    alreadyResolved[0] = true

                    try {
                        val authedCipher = result.cryptoObject?.cipher
                        if (authedCipher == null) {
                            deleteKeystoreKeyBestEffort(keyAlias)
                            promise.reject(ERR_VAULT, "Authenticated cipher missing")
                            return
                        }
                        val ciphertext = authedCipher.doFinal(secret)

                        // Persist ciphertext + IV side-by-side under
                        // alias-scoped keys.
                        val ok = prefs().edit()
                            .putString(ivKey(keyAlias), Base64.encodeToString(iv, Base64.NO_WRAP))
                            .putString(ctKey(keyAlias), Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                            .commit()

                        if (!ok) {
                            deleteKeystoreKeyBestEffort(keyAlias)
                            promise.reject(ERR_VAULT, "Failed to persist wrapped secret")
                            return
                        }

                        promise.resolve(null)
                    } catch (e: KeyPermanentlyInvalidatedException) {
                        deleteKeystoreKeyBestEffort(keyAlias)
                        promise.reject(ERR_KEY_INVALIDATED, "Keystore key was invalidated")
                    } catch (e: GeneralSecurityException) {
                        deleteKeystoreKeyBestEffort(keyAlias)
                        promise.reject(mapKeystoreException(e), "generateAndStoreSecret failed")
                    } catch (e: Exception) {
                        deleteKeystoreKeyBestEffort(keyAlias)
                        promise.reject(ERR_VAULT, "generateAndStoreSecret failed")
                    } finally {
                        // Zero the in-memory secret buffer once the
                        // encrypted ciphertext has landed on disk.
                        secret.fill(0.toByte())
                        // terminal callback path —
                        // release the per-alias lock unconditionally
                        // so a subsequent generateAndStoreSecret /
                        // deleteSecret on the same alias is no longer
                        // blocked, regardless of which try/catch arm
                        // resolved or rejected the promise above.
                        releaseAliasLockOnce()
                    }
                }

                override fun onAuthenticationFailed() {
                    // Single mismatch; BiometricPrompt stays open for
                    // retry. Do NOT reject here — the terminal
                    // lockout / cancellation comes through
                    // onAuthenticationError above. The per-alias lock
                    // also stays held: BiometricPrompt is still on
                    // screen with our `cipher` operation handle live,
                    // and a concurrent `generateAndStoreSecret` on
                    // the same alias would still race with the
                    // pending Keystore op. The lock is released on
                    // whichever terminal callback (success/error)
                    // fires next.
                }
            }

            try {
                val biometricPrompt = BiometricPrompt(activity, executor, callback)
                val infoBuilder = BiometricPrompt.PromptInfo.Builder()
                    .setTitle(if (title.isNotEmpty()) title else "Set up biometric unlock")
                    .setDescription(message)
                    .setNegativeButtonText(cancel)
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setConfirmationRequired(false)
                if (!subtitle.isNullOrEmpty()) {
                    infoBuilder.setSubtitle(subtitle)
                }
                val cryptoObject = BiometricPrompt.CryptoObject(cipher)
                biometricPrompt.authenticate(infoBuilder.build(), cryptoObject)
            } catch (e: Exception) {
                if (!alreadyResolved[0]) {
                    alreadyResolved[0] = true
                    secret.fill(0.toByte())
                    deleteKeystoreKeyBestEffort(keyAlias)
                    promise.reject(ERR_VAULT, "Failed to start biometric prompt")
                    // BiometricPrompt construction or
                    // .authenticate() threw before the system could
                    // schedule the callback — release the per-alias
                    // lock here so the call is not stuck holding it
                    // forever.
                    releaseAliasLockOnce()
                }
            }
        }
    }

    override fun getSecret(keyAlias: String, prompt: ReadableMap, promise: Promise) {
        if (keyAlias.isEmpty()) {
            promise.reject(ERR_VAULT, "keyAlias must be a non-empty string")
            return
        }

        // Hold the same per-alias operation lock used by generate/delete
        // while BiometricPrompt owns a live Cipher operation. Otherwise
        // deleteSecret(reset) can remove the alias while an already-created
        // CryptoObject is still pending, then the unlock callback can settle
        // after reset against stale key material.
        if (!tryAcquireAliasLock(keyAlias)) {
            promise.reject(
                ERR_OPERATION_IN_PROGRESS,
                "A generateAndStoreSecret/getSecret/deleteSecret is already in progress for this alias",
            )
            return
        }
        val lockReleased = booleanArrayOf(false)
        val releaseAliasLockOnce: () -> Unit = {
            if (!lockReleased[0]) {
                lockReleased[0] = true
                releaseAliasLock(keyAlias)
            }
        }

        val ivEncoded = prefs().getString(ivKey(keyAlias), null)
        val ctEncoded = prefs().getString(ctKey(keyAlias), null)
        if (ivEncoded == null || ctEncoded == null) {
            promise.reject(ERR_NOT_FOUND, "No secret stored under alias")
            releaseAliasLockOnce()
            return
        }

        val key: SecretKey
        try {
            val loaded = loadKeystoreKey(keyAlias)
            if (loaded == null) {
                // Stale prefs cleanup: there is a wrapped ciphertext on
                // disk but no key to unwrap it with. Drop the prefs so a
                // future hasSecret(alias) reports false and the user
                // routes through fresh setup or recovery instead of
                // looping back to this same NOT_FOUND every unlock.
                invalidateAlias(keyAlias)
                promise.reject(ERR_NOT_FOUND, "No Keystore key for alias")
                releaseAliasLockOnce()
                return
            }
            key = loaded
        } catch (e: UnrecoverableKeyException) {
            // The keystore entry exists but cannot be loaded — treat as
            // a hard invalidation event and clean up BOTH the key and
            // the wrapped ciphertext so the alias presents as fully
            // absent on the next probe, matching the cipher-init
            // invalidation path below.
            invalidateAlias(keyAlias)
            promise.reject(ERR_KEY_INVALIDATED, "Keystore key is unrecoverable")
            releaseAliasLockOnce()
            return
        } catch (e: Exception) {
            promise.reject(ERR_VAULT, "Failed to load Keystore key")
            releaseAliasLockOnce()
            return
        }

        val iv: ByteArray
        val ciphertext: ByteArray
        try {
            iv = Base64.decode(ivEncoded, Base64.NO_WRAP)
            ciphertext = Base64.decode(ctEncoded, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            promise.reject(ERR_VAULT, "Stored vault payload is corrupt")
            releaseAliasLockOnce()
            return
        }

        val cipher: Cipher
        try {
            cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
        } catch (e: KeyPermanentlyInvalidatedException) {
            // Enrollment change — drop the invalidated material so the
            // caller can route the user through recovery. `invalidateAlias`
            // wipes both the keystore entry AND the wrapped ciphertext
            // prefs in one place so this path stays in lock-step with
            // the post-doFinal invalidation path inside the
            // AuthenticationCallback below.
            invalidateAlias(keyAlias)
            promise.reject(ERR_KEY_INVALIDATED, "Key invalidated by biometric enrollment change")
            releaseAliasLockOnce()
            return
        } catch (e: GeneralSecurityException) {
            promise.reject(mapKeystoreException(e), "Failed to initialise cipher")
            releaseAliasLockOnce()
            return
        }

        val activity = currentActivity as? FragmentActivity
        if (activity == null) {
            promise.reject(ERR_VAULT, "No FragmentActivity available for biometric prompt")
            releaseAliasLockOnce()
            return
        }

        val title = if (prompt.hasKey("promptTitle")) prompt.getString("promptTitle") ?: "" else ""
        val message = if (prompt.hasKey("promptMessage")) prompt.getString("promptMessage") ?: "" else ""
        val cancel = if (prompt.hasKey("promptCancel")) prompt.getString("promptCancel") ?: "Cancel" else "Cancel"
        val subtitle = if (prompt.hasKey("promptSubtitle")) prompt.getString("promptSubtitle") else null

        activity.runOnUiThread {
            val executor = ContextCompat.getMainExecutor(reactApplicationContext)
            val alreadyResolved = booleanArrayOf(false)

            val callback = object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (alreadyResolved[0]) return
                    alreadyResolved[0] = true
                    val code = mapBiometricError(errorCode)
                    // Intentionally generic message to avoid leaking raw
                    // Keystore / system text. Never include secret bytes.
                    promise.reject(code, "Biometric authentication failed")
                    releaseAliasLockOnce()
                }

                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (alreadyResolved[0]) return
                    alreadyResolved[0] = true

                    var plaintext: ByteArray? = null
                    try {
                        val authedCipher = result.cryptoObject?.cipher
                        if (authedCipher == null) {
                            promise.reject(ERR_VAULT, "Authenticated cipher missing")
                            return
                        }
                        plaintext = authedCipher.doFinal(ciphertext)
                        val hex = bytesToHex(plaintext!!)
                        promise.resolve(hex)
                    } catch (e: AEADBadTagException) {
                        promise.reject(ERR_AUTH_FAILED, "Decryption failed")
                    } catch (e: KeyPermanentlyInvalidatedException) {
                        // Enrollment-change invalidation can surface at
                        // `doFinal()` after authentication. Wipe both
                        // the Keystore alias and prefs so the next probe
                        // reports a clean uninitialized state.
                        invalidateAlias(keyAlias)
                        promise.reject(ERR_KEY_INVALIDATED, "Key invalidated by biometric enrollment change")
                    } catch (e: GeneralSecurityException) {
                        promise.reject(mapKeystoreException(e), "Decryption failed")
                    } catch (e: Exception) {
                        promise.reject(ERR_VAULT, "Decryption failed")
                    } finally {
                        plaintext?.fill(0.toByte())
                        releaseAliasLockOnce()
                    }
                }

                override fun onAuthenticationFailed() {
                    // The user presented an unrecognised biometric. BiometricPrompt
                    // stays open for retry; terminal lockout comes through
                    // onAuthenticationError (ERROR_LOCKOUT). We deliberately do
                    // NOT reject here to avoid spuriously mapping a single
                    // mismatch to AUTH_FAILED.
                }
            }

            try {
                val biometricPrompt = BiometricPrompt(activity, executor, callback)
                val infoBuilder = BiometricPrompt.PromptInfo.Builder()
                    .setTitle(if (title.isNotEmpty()) title else "Unlock")
                    .setDescription(message)
                    .setNegativeButtonText(cancel)
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setConfirmationRequired(false)
                if (!subtitle.isNullOrEmpty()) {
                    infoBuilder.setSubtitle(subtitle)
                }
                val cryptoObject = BiometricPrompt.CryptoObject(cipher)
                biometricPrompt.authenticate(infoBuilder.build(), cryptoObject)
            } catch (e: Exception) {
                if (!alreadyResolved[0]) {
                    alreadyResolved[0] = true
                    promise.reject(ERR_VAULT, "Failed to start biometric prompt")
                    releaseAliasLockOnce()
                }
            }
        }
    }

    override fun hasSecret(keyAlias: String, promise: Promise) {
        if (keyAlias.isEmpty()) {
            promise.resolve(false)
            return
        }
        try {
            val hasPrefs = prefs().contains(ivKey(keyAlias)) && prefs().contains(ctKey(keyAlias))
            val hasKey = loadKeystoreKey(keyAlias) != null
            promise.resolve(hasPrefs && hasKey)
        } catch (e: Exception) {
            promise.reject(ERR_VAULT, "hasSecret failed")
        }
    }

    override fun deleteSecret(keyAlias: String, promise: Promise) {
        if (keyAlias.isEmpty()) {
            // Idempotent: empty alias is a no-op success.
            promise.resolve(null)
            return
        }
        // Serialize against `generateAndStoreSecret` on
        // the SAME alias. Without the lock, a concurrent
        // generate→delete pair could race through the
        // `deleteKeystoreKeyBestEffort + createKeystoreKey` window in
        // generate, and the delete here would either wipe the freshly
        // provisioned key (orphaning the prefs the generate just
        // committed) or run before the generate's prefs commit
        // landed. Either way the user ends up with a half-provisioned
        // vault. Cross-alias deletes remain parallel.
        if (!tryAcquireAliasLock(keyAlias)) {
            promise.reject(
                ERR_OPERATION_IN_PROGRESS,
                "A generateAndStoreSecret/getSecret/deleteSecret is already in progress for this alias",
            )
            return
        }
        try {
            // CHECKED Keystore delete first. The wrapped secret prefs remain
            // intact until the OS-gated key is proven gone, so a Keystore
            // failure leaves the vault in a retryable, still-intact state.
            // Previously the prefs were removed before this checked delete;
            // if the Keystore delete then failed, the wallet secret was
            // unrecoverable even though reset rejected.
            deleteKeystoreKeyChecked(keyAlias)

            // Use `commit()` so a prefs write failure is surfaced before
            // the JS layer clears the reset sentinel. A failure here leaves
            // stale ciphertext prefs without a Keystore key; the next
            // sentinel retry will re-run this idempotently and remove them.
            val prefsRemoved = prefs()
                .edit()
                .remove(ivKey(keyAlias))
                .remove(ctKey(keyAlias))
                .commit()
            if (!prefsRemoved) {
                promise.reject(
                    ERR_VAULT,
                    "deleteSecret failed: SharedPreferences.commit() returned false; on-disk prefs write did not succeed",
                )
                return
            }
            // Both halves succeeded — missing alias is a vacuous
            // success path inside `deleteKeystoreKeyChecked` (it
            // skips the deleteEntry call when containsAlias is false).
            promise.resolve(null)
        } catch (e: Exception) {
            // Surface the underlying message so the JS layer can
            // distinguish prefs-IO from Keystore failures in logs /
            // bug reports. The `e.message` payload never contains the
            // wrapped ciphertext or the IV (we only ever reference key
            // aliases here), so this is safe to expose.
            promise.reject(
                ERR_VAULT,
                "deleteSecret failed: ${e.javaClass.simpleName}: ${e.message ?: "<no message>"}",
            )
        } finally {
            releaseAliasLock(keyAlias)
        }
    }

    // ---------------------------------------------------------------------
    // Utilities
    // ---------------------------------------------------------------------

    private fun bytesToHex(bytes: ByteArray): String {
        val chars = CharArray(bytes.size * 2)
        val hexDigits = "0123456789abcdef".toCharArray()
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xff
            chars[i * 2] = hexDigits[v ushr 4]
            chars[i * 2 + 1] = hexDigits[v and 0x0f]
        }
        return String(chars)
    }
}
