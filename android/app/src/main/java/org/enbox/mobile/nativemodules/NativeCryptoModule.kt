package org.enbox.mobile.nativemodules

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.enbox.mobile.nativemodules.NativeCryptoSpec
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

class NativeCryptoModule(reactContext: ReactApplicationContext) :
    NativeCryptoSpec(reactContext) {

    companion object {
        const val NAME = "NativeCrypto"
        private val secureRandom = SecureRandom()
    }

    override fun getName(): String = NAME

    override fun sha256(data: String, promise: Promise) {
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            val hash = digest.digest(data.toByteArray(Charsets.UTF_8))
            promise.resolve(hash.toHex())
        } catch (e: Exception) {
            promise.reject("CRYPTO_ERROR", "SHA-256 hash failed", e)
        }
    }

    override fun pbkdf2(password: String, salt: String, iterations: Double, keyLength: Double, promise: Promise) {
        try {
            val keyLen = keyLength.toInt()
            if (keyLen <= 0 || keyLen > 128) {
                promise.reject("CRYPTO_ERROR", "Key length must be between 1 and 128")
                return
            }

            val spec = PBEKeySpec(
                password.toCharArray(),
                salt.toByteArray(Charsets.UTF_8),
                iterations.toInt(),
                keyLen * 8 // PBEKeySpec uses bits
            )
            val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            val key = factory.generateSecret(spec).encoded
            promise.resolve(key.toHex())
        } catch (e: Exception) {
            promise.reject("CRYPTO_ERROR", "PBKDF2 derivation failed", e)
        }
    }

    override fun randomBytes(length: Double, promise: Promise) {
        try {
            val byteCount = length.toInt()
            if (byteCount <= 0 || byteCount > 1024) {
                promise.reject("CRYPTO_ERROR", "Byte count must be between 1 and 1024")
                return
            }
            val bytes = ByteArray(byteCount)
            secureRandom.nextBytes(bytes)
            promise.resolve(bytes.toHex())
        } catch (e: Exception) {
            promise.reject("CRYPTO_ERROR", "Random bytes generation failed", e)
        }
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
