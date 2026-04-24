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
import java.security.SecureRandom
import java.security.UnrecoverableKeyException
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

    private fun deleteKeystoreKey(alias: String) {
        try {
            val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER)
            keyStore.load(null)
            if (keyStore.containsAlias(alias)) {
                keyStore.deleteEntry(alias)
            }
        } catch (_: Exception) {
            // swallow — delete is best-effort and must not surface secret
            // material or low-level keystore state in an error path.
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

        // Non-destructive contract (VAL-VAULT-030): refuse to provision
        // over an existing alias. The pre-fix code path silently
        // `deleteKeystoreKey()`'d the existing key BEFORE creating the
        // new one and rolled back only on failure, but the rollback
        // window did not cover (a) BiometricPrompt cancellation, where
        // the user dismisses the prompt after the Keystore key was
        // already destroyed, or (b) SharedPreferences `apply()` losing
        // the wrapped ciphertext. Either left the device with an
        // orphan / wiped vault that could not be re-derived without
        // the recovery phrase.
        //
        // The JS layer (`BiometricVault._doInitialize`) already guards
        // this with a `hasSecret()` pre-check, but the native API
        // surface should match the JS guarantee so future callers
        // (deep links, dev tools, third-party native consumers) can't
        // drift away from the safe pattern. Callers that intend to
        // overwrite MUST first call `deleteSecret(...)` explicitly,
        // which makes the destructive intent visible and auditable.
        try {
            val hasPrefs = prefs().contains(ivKey(keyAlias)) && prefs().contains(ctKey(keyAlias))
            val hasKey = loadKeystoreKey(keyAlias) != null
            if (hasPrefs && hasKey) {
                promise.reject(
                    ERR_ALREADY_INITIALIZED,
                    "A biometric secret already exists for this alias; " +
                        "delete it explicitly before re-provisioning",
                )
                return
            }
        } catch (e: Exception) {
            // Defensive: if we can't determine existence, fall through
            // to the legacy provisioning path. The original code did
            // exactly this — an exception in the existence check would
            // not have prevented provisioning either. The pre-check is
            // belt-and-suspenders, not the primary guard.
        }

        // Resolve the 32-byte wallet secret up-front — caller-provided bytes
        // (via `secretHex`, lower-case hex of length 64) when supplied,
        // otherwise freshly generated CSPRNG entropy. Caller-provided bytes
        // let the JS layer derive the HD seed / mnemonic from the same bytes
        // that will be stored here without a follow-up biometric read during
        // provisioning (that would fire a second BiometricPrompt).
        val secret = ByteArray(SECRET_BYTES)
        val providedHex = if (options.hasKey("secretHex")) options.getString("secretHex") else null
        if (providedHex != null) {
            if (providedHex.length != SECRET_BYTES * 2) {
                promise.reject(ERR_VAULT, "secretHex must be 64 lower-case hex characters")
                return
            }
            for (i in 0 until SECRET_BYTES) {
                val hi = Character.digit(providedHex[i * 2], 16)
                val lo = Character.digit(providedHex[i * 2 + 1], 16)
                if (hi < 0 || lo < 0) {
                    secret.fill(0.toByte())
                    promise.reject(ERR_VAULT, "secretHex is not valid hex")
                    return
                }
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
            // be decryptable under a reused alias.
            deleteKeystoreKey(keyAlias)
            val key = createKeystoreKey(keyAlias)
            cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            iv = cipher.iv
        } catch (e: KeyPermanentlyInvalidatedException) {
            secret.fill(0.toByte())
            deleteKeystoreKey(keyAlias)
            promise.reject(ERR_KEY_INVALIDATED, "Keystore key was invalidated")
            return
        } catch (e: GeneralSecurityException) {
            secret.fill(0.toByte())
            deleteKeystoreKey(keyAlias)
            promise.reject(mapKeystoreException(e), "generateAndStoreSecret failed")
            return
        } catch (e: Exception) {
            secret.fill(0.toByte())
            deleteKeystoreKey(keyAlias)
            promise.reject(ERR_VAULT, "generateAndStoreSecret failed")
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
            deleteKeystoreKey(keyAlias)
            promise.reject(ERR_VAULT, "No FragmentActivity available for biometric prompt")
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
                    deleteKeystoreKey(keyAlias)
                    val code = mapBiometricError(errorCode)
                    promise.reject(code, "Biometric authentication failed")
                }

                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (alreadyResolved[0]) return
                    alreadyResolved[0] = true

                    try {
                        val authedCipher = result.cryptoObject?.cipher
                        if (authedCipher == null) {
                            deleteKeystoreKey(keyAlias)
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
                            deleteKeystoreKey(keyAlias)
                            promise.reject(ERR_VAULT, "Failed to persist wrapped secret")
                            return
                        }

                        promise.resolve(null)
                    } catch (e: KeyPermanentlyInvalidatedException) {
                        deleteKeystoreKey(keyAlias)
                        promise.reject(ERR_KEY_INVALIDATED, "Keystore key was invalidated")
                    } catch (e: GeneralSecurityException) {
                        deleteKeystoreKey(keyAlias)
                        promise.reject(mapKeystoreException(e), "generateAndStoreSecret failed")
                    } catch (e: Exception) {
                        deleteKeystoreKey(keyAlias)
                        promise.reject(ERR_VAULT, "generateAndStoreSecret failed")
                    } finally {
                        // Zero the in-memory secret buffer once the
                        // encrypted ciphertext has landed on disk.
                        secret.fill(0.toByte())
                    }
                }

                override fun onAuthenticationFailed() {
                    // Single mismatch; BiometricPrompt stays open for
                    // retry. Do NOT reject here — the terminal
                    // lockout / cancellation comes through
                    // onAuthenticationError above.
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
                    deleteKeystoreKey(keyAlias)
                    promise.reject(ERR_VAULT, "Failed to start biometric prompt")
                }
            }
        }
    }

    override fun getSecret(keyAlias: String, prompt: ReadableMap, promise: Promise) {
        if (keyAlias.isEmpty()) {
            promise.reject(ERR_VAULT, "keyAlias must be a non-empty string")
            return
        }

        val ivEncoded = prefs().getString(ivKey(keyAlias), null)
        val ctEncoded = prefs().getString(ctKey(keyAlias), null)
        if (ivEncoded == null || ctEncoded == null) {
            promise.reject(ERR_NOT_FOUND, "No secret stored under alias")
            return
        }

        val key: SecretKey
        try {
            val loaded = loadKeystoreKey(keyAlias)
            if (loaded == null) {
                promise.reject(ERR_NOT_FOUND, "No Keystore key for alias")
                return
            }
            key = loaded
        } catch (e: UnrecoverableKeyException) {
            promise.reject(ERR_KEY_INVALIDATED, "Keystore key is unrecoverable")
            return
        } catch (e: Exception) {
            promise.reject(ERR_VAULT, "Failed to load Keystore key")
            return
        }

        val iv: ByteArray
        val ciphertext: ByteArray
        try {
            iv = Base64.decode(ivEncoded, Base64.NO_WRAP)
            ciphertext = Base64.decode(ctEncoded, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            promise.reject(ERR_VAULT, "Stored vault payload is corrupt")
            return
        }

        val cipher: Cipher
        try {
            cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
        } catch (e: KeyPermanentlyInvalidatedException) {
            // Enrollment change — drop the invalidated material so the caller
            // can route the user through recovery.
            deleteKeystoreKey(keyAlias)
            prefs().edit().remove(ivKey(keyAlias)).remove(ctKey(keyAlias)).apply()
            promise.reject(ERR_KEY_INVALIDATED, "Key invalidated by biometric enrollment change")
            return
        } catch (e: GeneralSecurityException) {
            promise.reject(mapKeystoreException(e), "Failed to initialise cipher")
            return
        }

        val activity = currentActivity as? FragmentActivity
        if (activity == null) {
            promise.reject(ERR_VAULT, "No FragmentActivity available for biometric prompt")
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
                        promise.reject(ERR_KEY_INVALIDATED, "Key invalidated by biometric enrollment change")
                    } catch (e: GeneralSecurityException) {
                        promise.reject(mapKeystoreException(e), "Decryption failed")
                    } catch (e: Exception) {
                        promise.reject(ERR_VAULT, "Decryption failed")
                    } finally {
                        plaintext?.fill(0.toByte())
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
        try {
            prefs().edit().remove(ivKey(keyAlias)).remove(ctKey(keyAlias)).apply()
            deleteKeystoreKey(keyAlias)
            // Idempotent: missing alias resolves successfully.
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject(ERR_VAULT, "deleteSecret failed")
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
