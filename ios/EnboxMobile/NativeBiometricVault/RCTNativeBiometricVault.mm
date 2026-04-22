#import "RCTNativeBiometricVault.h"
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>

// Dedicated Keychain service namespace for the biometric vault. Must be
// DISTINCT from RCTNativeSecureStorage's `org.enbox.mobile.secure` so that a
// non-biometric write under the same account does not strip the biometric
// access-control on an existing item.
static NSString *const kBiometricVaultService = @"org.enbox.mobile.biometric";

// Canonical error codes surfaced to JS. These strings must match exactly
// across iOS, Android, and the JS layer. Do NOT localize or rephrase.
static NSString *const kErrUserCanceled        = @"USER_CANCELED";
static NSString *const kErrBiometryUnavailable = @"BIOMETRY_UNAVAILABLE";
static NSString *const kErrBiometryNotEnrolled = @"BIOMETRY_NOT_ENROLLED";
static NSString *const kErrBiometryLockout     = @"BIOMETRY_LOCKOUT";
static NSString *const kErrKeyInvalidated      = @"KEY_INVALIDATED";
static NSString *const kErrNotFound            = @"NOT_FOUND";
static NSString *const kErrAuthFailed          = @"AUTH_FAILED";
static NSString *const kErrVault               = @"VAULT_ERROR";

// Length of the generated wallet secret, in bytes (32 bytes = 256 bits).
static const NSUInteger kBiometricVaultSecretByteLength = 32;

@implementation RCTNativeBiometricVault {
  dispatch_queue_t _keychainQueue;
}

#pragma mark - Lifecycle

- (instancetype)init {
  if ((self = [super init])) {
    _keychainQueue = dispatch_queue_create("org.enbox.mobile.biometric-vault", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeBiometricVaultSpecJSI>(params);
}

+ (NSString *)moduleName {
  return @"NativeBiometricVault";
}

#pragma mark - Helpers

- (NSMutableDictionary *)baseQueryForKey:(NSString *)keyAlias {
  return [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: kBiometricVaultService,
    (__bridge id)kSecAttrAccount: keyAlias ?: @"",
    // Never allow iCloud sync — this secret is device-bound.
    (__bridge id)kSecAttrSynchronizable: (__bridge id)kCFBooleanFalse,
  } mutableCopy];
}

- (NSString *)biometryTypeString:(LAContext *)context {
  // LAContext.biometryType is only populated after canEvaluatePolicy has been
  // called. Callers must invoke canEvaluatePolicy before reading this.
  switch (context.biometryType) {
    case LABiometryTypeFaceID:
      return @"faceID";
    case LABiometryTypeTouchID:
      return @"touchID";
    default:
      return @"none";
  }
}

- (NSString *)codeForLAError:(NSInteger)code {
  switch (code) {
    case LAErrorUserCancel:
    case LAErrorAppCancel:
    case LAErrorSystemCancel:
    case LAErrorUserFallback:
      return kErrUserCanceled;
    case LAErrorBiometryNotAvailable:
      return kErrBiometryUnavailable;
    case LAErrorBiometryNotEnrolled:
      return kErrBiometryNotEnrolled;
    case LAErrorBiometryLockout:
      return kErrBiometryLockout;
    case LAErrorInvalidContext:
      return kErrKeyInvalidated;
    case LAErrorAuthenticationFailed:
      return kErrAuthFailed;
    default:
      return kErrVault;
  }
}

- (NSString *)codeForOSStatus:(OSStatus)status {
  switch (status) {
    case errSecItemNotFound:
      return kErrNotFound;
    case errSecUserCanceled:
      return kErrUserCanceled;
    case errSecAuthFailed:
      return kErrAuthFailed;
    case errSecInvalidData:
    case errSecDecode:
    case errSecInteractionNotAllowed:
      // Biometric enrollment change invalidates the ACL; the item is still
      // present but cannot be unwrapped. Surface as KEY_INVALIDATED so the
      // recovery flow can trigger.
      return kErrKeyInvalidated;
    case errSecNotAvailable:
      return kErrBiometryUnavailable;
    default:
      return kErrVault;
  }
}

- (void)rejectFromOSStatus:(OSStatus)status
                     where:(NSString *)where
                   rejecter:(RCTPromiseRejectBlock)reject {
  NSString *code = [self codeForOSStatus:status];
  // Keep the message generic so no secret or user data leaks into JS/logs.
  NSString *message = [NSString stringWithFormat:@"%@ failed (OSStatus %d)", where, (int)status];
  reject(code, message, nil);
}

#pragma mark - NativeBiometricVaultSpec

- (void)isBiometricAvailable:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_keychainQueue, ^{
    LAContext *context = [[LAContext alloc] init];
    NSError *laError = nil;
    BOOL canEvaluate = [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics
                                            error:&laError];

    NSString *biometryType = [self biometryTypeString:context];
    NSMutableDictionary *result = [@{
      @"available": @(canEvaluate),
      @"enrolled": @(canEvaluate),
      @"type": biometryType,
    } mutableCopy];

    if (!canEvaluate) {
      // Refine availability vs enrollment where possible.
      if (laError.code == LAErrorBiometryNotEnrolled) {
        result[@"available"] = @YES;
        result[@"enrolled"] = @NO;
        result[@"reason"] = @"BIOMETRY_NOT_ENROLLED";
      } else if (laError.code == LAErrorBiometryNotAvailable ||
                 laError.code == LAErrorBiometryLockout) {
        result[@"available"] = @NO;
        result[@"enrolled"] = @NO;
        result[@"reason"] = (laError.code == LAErrorBiometryLockout)
            ? @"BIOMETRY_LOCKOUT"
            : @"BIOMETRY_UNAVAILABLE";
      } else {
        result[@"available"] = @NO;
        result[@"enrolled"] = @NO;
        result[@"reason"] = @"BIOMETRY_UNAVAILABLE";
      }
      if ([biometryType isEqualToString:@"none"]) {
        result[@"type"] = @"none";
      }
    }
    resolve([result copy]);
  });
}

- (void)generateAndStoreSecret:(NSString *)keyAlias
                       options:(NSDictionary *)options
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject {
  if (keyAlias.length == 0) {
    reject(kErrVault, @"keyAlias must be a non-empty string", nil);
    return;
  }

  // requireBiometrics is part of the cross-platform contract. For the
  // biometric vault, we *always* gate with BiometryCurrentSet — a future
  // caller passing `false` must NOT silently fall back to an unauthenticated
  // Keychain item. Enforce it loudly.
  id requireValue = options[@"requireBiometrics"];
  BOOL requireBiometrics = [requireValue isKindOfClass:[NSNumber class]] ? [requireValue boolValue] : YES;
  if (!requireBiometrics) {
    reject(kErrVault,
           @"requireBiometrics=false is not supported by the biometric vault",
           nil);
    return;
  }

  dispatch_async(_keychainQueue, ^{
    // Generate a fresh 256-bit secret.
    NSMutableData *secretData = [NSMutableData dataWithLength:kBiometricVaultSecretByteLength];
    OSStatus randStatus = SecRandomCopyBytes(kSecRandomDefault,
                                             kBiometricVaultSecretByteLength,
                                             secretData.mutableBytes);
    if (randStatus != errSecSuccess) {
      reject(kErrVault, @"Failed to generate random secret", nil);
      return;
    }

    // Construct the access control object that requires:
    //   - device to be unlocked AND a passcode set on the device
    //   - the *current* set of enrolled biometrics (enrollment change
    //     automatically invalidates this item → KEY_INVALIDATED on read).
    // BiometryCurrentSet MUST NOT be combined with DevicePasscode or
    // UserPresence flags — those would allow passcode fallback, which is
    // explicitly forbidden by the mission contract.
    CFErrorRef aclError = NULL;
    SecAccessControlRef sacRef = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
        kSecAccessControlBiometryCurrentSet,
        &aclError);
    if (sacRef == NULL || aclError != NULL) {
      if (aclError != NULL) CFRelease(aclError);
      if (sacRef != NULL) CFRelease(sacRef);
      reject(kErrVault, @"Failed to create biometric access control", nil);
      // Best-effort clear the secret buffer.
      [secretData resetBytesInRange:NSMakeRange(0, secretData.length)];
      return;
    }

    // Upsert: delete any pre-existing item for this alias first, then add.
    NSMutableDictionary *deleteQuery = [@{
      (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: kBiometricVaultService,
      (__bridge id)kSecAttrAccount: keyAlias,
    } mutableCopy];
    SecItemDelete((__bridge CFDictionaryRef)deleteQuery);

    NSMutableDictionary *addQuery = [@{
      (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: kBiometricVaultService,
      (__bridge id)kSecAttrAccount: keyAlias,
      (__bridge id)kSecValueData: secretData,
      (__bridge id)kSecAttrAccessControl: (__bridge_transfer id)sacRef,
      (__bridge id)kSecAttrSynchronizable: (__bridge id)kCFBooleanFalse,
    } mutableCopy];

    OSStatus status = SecItemAdd((__bridge CFDictionaryRef)addQuery, NULL);

    // Best-effort zeroize the in-memory secret buffer before returning. Do
    // NOT log secretData under any circumstances.
    [secretData resetBytesInRange:NSMakeRange(0, secretData.length)];

    if (status == errSecSuccess) {
      resolve(nil);
    } else {
      [self rejectFromOSStatus:status where:@"generateAndStoreSecret" rejecter:reject];
    }
  });
}

- (void)getSecret:(NSString *)keyAlias
           prompt:(NSDictionary *)prompt
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  if (keyAlias.length == 0) {
    reject(kErrVault, @"keyAlias must be a non-empty string", nil);
    return;
  }

  NSString *promptMessage = [prompt[@"promptMessage"] isKindOfClass:[NSString class]]
      ? prompt[@"promptMessage"] : @"";
  NSString *promptCancel = [prompt[@"promptCancel"] isKindOfClass:[NSString class]]
      ? prompt[@"promptCancel"] : nil;

  dispatch_async(_keychainQueue, ^{
    LAContext *context = [[LAContext alloc] init];
    // Biometrics-only. We deliberately rely on BiometryCurrentSet flags and
    // never use the device-passcode / user-presence variants that would
    // permit a passcode fallback.
    if (promptCancel.length > 0) {
      context.localizedCancelTitle = promptCancel;
    }

    NSMutableDictionary *query = [self baseQueryForKey:keyAlias];
    query[(__bridge id)kSecReturnData] = @YES;
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    query[(__bridge id)kSecUseAuthenticationContext] = context;
    // kSecUseOperationPrompt is the message shown inside the system biometric
    // dialog. Title is drawn from the app's Info.plist NSFaceIDUsageDescription
    // / system default.
    query[(__bridge id)kSecUseOperationPrompt] = promptMessage ?: @"";

    CFDataRef dataRef = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query,
                                          (CFTypeRef *)&dataRef);

    if (status == errSecSuccess && dataRef != NULL) {
      NSData *data = (__bridge_transfer NSData *)dataRef;

      // Encode as lower-case hex. Never NSLog the data.
      const uint8_t *bytes = (const uint8_t *)data.bytes;
      NSUInteger length = data.length;
      NSMutableString *hex = [NSMutableString stringWithCapacity:length * 2];
      for (NSUInteger i = 0; i < length; i++) {
        [hex appendFormat:@"%02x", bytes[i]];
      }
      resolve([hex copy]);
    } else {
      if (dataRef != NULL) CFRelease(dataRef);
      [self rejectFromOSStatus:status where:@"getSecret" rejecter:reject];
    }
  });
}

- (void)hasSecret:(NSString *)keyAlias
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  if (keyAlias.length == 0) {
    // An empty alias is not a real entry; resolve false rather than reject so
    // callers can cheaply probe without a try/catch.
    resolve(@NO);
    return;
  }

  dispatch_async(_keychainQueue, ^{
    NSMutableDictionary *query = [self baseQueryForKey:keyAlias];
    query[(__bridge id)kSecReturnAttributes] = @YES;
    query[(__bridge id)kSecReturnData] = @NO;
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    // Suppress any biometric UI; we only care about presence.
    query[(__bridge id)kSecUseAuthenticationUI] = (__bridge id)kSecUseAuthenticationUIFail;

    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (result != NULL) CFRelease(result);

    if (status == errSecSuccess || status == errSecInteractionNotAllowed) {
      // Item exists (possibly requires interaction to unwrap, but it is
      // present in the keychain).
      resolve(@YES);
    } else if (status == errSecItemNotFound) {
      resolve(@NO);
    } else {
      [self rejectFromOSStatus:status where:@"hasSecret" rejecter:reject];
    }
  });
}

- (void)deleteSecret:(NSString *)keyAlias
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  if (keyAlias.length == 0) {
    // deleteSecret is idempotent; treat empty alias as a no-op.
    resolve(nil);
    return;
  }

  dispatch_async(_keychainQueue, ^{
    NSMutableDictionary *query = [@{
      (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: kBiometricVaultService,
      (__bridge id)kSecAttrAccount: keyAlias,
    } mutableCopy];

    OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);
    if (status == errSecSuccess || status == errSecItemNotFound) {
      // Idempotent: missing alias is a successful no-op.
      resolve(nil);
    } else {
      [self rejectFromOSStatus:status where:@"deleteSecret" rejecter:reject];
    }
  });
}

@end
