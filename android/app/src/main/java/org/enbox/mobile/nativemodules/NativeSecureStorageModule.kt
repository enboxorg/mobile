package org.enbox.mobile.nativemodules

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.enbox.mobile.nativemodules.NativeSecureStorageSpec
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class NativeSecureStorageModule(reactContext: ReactApplicationContext) :
    NativeSecureStorageSpec(reactContext) {

    companion object {
        const val NAME = "NativeSecureStorage"
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val KEY_ALIAS = "org.enbox.mobile.secure"
        private const val PREFS_NAME = "org.enbox.mobile.secure.prefs"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_LENGTH = 128
        private const val IV_SEPARATOR = ":"
    }

    override fun getName(): String = NAME

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER)
        keyStore.load(null)

        keyStore.getKey(KEY_ALIAS, null)?.let { return it as SecretKey }

        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
        keyGen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return keyGen.generateKey()
    }

    override fun getItem(key: String, promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences(PREFS_NAME, 0)
            val encrypted = prefs.getString(key, null)
            if (encrypted == null) {
                promise.resolve(null)
                return
            }

            val parts = encrypted.split(IV_SEPARATOR, limit = 2)
            if (parts.size != 2) {
                promise.resolve(null)
                return
            }

            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val cipherText = Base64.decode(parts[1], Base64.NO_WRAP)

            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_LENGTH, iv))
            val decrypted = cipher.doFinal(cipherText)

            promise.resolve(String(decrypted, Charsets.UTF_8))
        } catch (e: Exception) {
            promise.reject("KEYSTORE_ERROR", "Failed to read from secure storage", e)
        }
    }

    override fun setItem(key: String, value: String, promise: Promise) {
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val cipherText = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            val iv = cipher.iv

            val encoded = Base64.encodeToString(iv, Base64.NO_WRAP) +
                    IV_SEPARATOR +
                    Base64.encodeToString(cipherText, Base64.NO_WRAP)

            val prefs = reactApplicationContext.getSharedPreferences(PREFS_NAME, 0)
            val success = prefs.edit().putString(key, encoded).commit()

            if (success) {
                promise.resolve(null)
            } else {
                promise.reject("KEYSTORE_ERROR", "SharedPreferences commit failed")
            }
        } catch (e: Exception) {
            promise.reject("KEYSTORE_ERROR", "Failed to write to secure storage", e)
        }
    }

    override fun deleteItem(key: String, promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences(PREFS_NAME, 0)
            val success = prefs.edit().remove(key).commit()

            if (success) {
                promise.resolve(null)
            } else {
                promise.reject("KEYSTORE_ERROR", "SharedPreferences commit failed")
            }
        } catch (e: Exception) {
            promise.reject("KEYSTORE_ERROR", "Failed to delete from secure storage", e)
        }
    }
}
