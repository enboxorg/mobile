package org.enbox.mobile.nativemodules

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class NativeModulesPackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        when (name) {
            NativeSecureStorageModule.NAME -> NativeSecureStorageModule(reactContext)
            NativeCryptoModule.NAME -> NativeCryptoModule(reactContext)
            NativeBiometricVaultModule.NAME -> NativeBiometricVaultModule(reactContext)
            else -> null
        }

    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        mapOf(
            NativeSecureStorageModule.NAME to ReactModuleInfo(
                name = NativeSecureStorageModule.NAME,
                className = NativeSecureStorageModule.NAME,
                canOverrideExistingModule = false,
                needsEagerInit = false,
                isCxxModule = false,
                isTurboModule = true
            ),
            NativeCryptoModule.NAME to ReactModuleInfo(
                name = NativeCryptoModule.NAME,
                className = NativeCryptoModule.NAME,
                canOverrideExistingModule = false,
                needsEagerInit = false,
                isCxxModule = false,
                isTurboModule = true
            ),
            NativeBiometricVaultModule.NAME to ReactModuleInfo(
                name = NativeBiometricVaultModule.NAME,
                className = NativeBiometricVaultModule.NAME,
                canOverrideExistingModule = false,
                needsEagerInit = false,
                isCxxModule = false,
                isTurboModule = true
            )
        )
    }
}
