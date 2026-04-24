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
// VAL-VAULT-030: explicit non-destructive contract on
// `generateAndStoreSecret`. The native API is NOT an upsert — calling
// it over an existing alias rejects with this code so a mid-setup
// LAContext cancel / `SecItemAdd` failure cannot wipe a working wallet
// via the silent SecItemDelete-then-SecItemAdd pattern that previously
// occupied lines 328-345.
static NSString *const kErrAlreadyInitialized  = @"VAULT_ERROR_ALREADY_INITIALIZED";

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
      // `errSecAuthFailed` on a biometry-current-set ACL item is a
      // retryable biometric mismatch — the user presented a biometric
      // that did not match the enrolled template (wrong face, wrong
      // finger, glasses, hat, lighting, etc). The ACL itself is still
      // valid; a retry with a better biometric presentation will
      // succeed.
      //
      // We deliberately do NOT escalate this to KEY_INVALIDATED.
      // Enrollment-change invalidation on iOS surfaces as the item
      // being AUTO-DELETED (`errSecItemNotFound`) or as data the
      // system can no longer decode (`errSecInvalidData` /
      // `errSecDecode` / `errSecInteractionNotAllowed`); those codes
      // land on `kErrKeyInvalidated` below. See VAL-VAULT-023.
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

// Map a `getSecret()` OSStatus to a canonical VAULT_ERROR_* code.
//
// Historically this helper tried to disambiguate `errSecAuthFailed` into
// `KEY_INVALIDATED` when `canEvaluatePolicy` still reported YES — the
// assumption was "if biometrics can still be evaluated yet Keychain
// refused auth, the stored biometry-current-set ACL must have been
// invalidated by an enrollment change". In practice that signal is
// ambiguous (VAL-VAULT-023): a user who fails Face ID once (wrong
// angle, wrong face presented, etc.) will leave `canEvaluatePolicy`
// perfectly YES yet produce `errSecAuthFailed`. Mapping that to
// `KEY_INVALIDATED` routed the user into the recovery-restore flow
// even though their key was still fine — a privacy/UX footgun that
// forced re-typing the 24-word mnemonic after a single finger slip.
//
// On iOS the actual key-invalidation signal is different:
//   - A biometry-current-set item whose enrollment has changed is
//     AUTO-DELETED by the system at the enrollment-change boundary.
//     A subsequent `SecItemCopyMatching` returns `errSecItemNotFound`,
//     which is already mapped to `NOT_FOUND` by `codeForOSStatus:`.
//   - `errSecInvalidData` / `errSecDecode` / `errSecInteractionNotAllowed`
//     are the remaining "the item exists but cannot be unwrapped"
//     signals — those stay on the `KEY_INVALIDATED` path inside
//     `codeForOSStatus:`.
//
// Therefore: `errSecAuthFailed` ALWAYS maps to `AUTH_FAILED`
// (retryable). The `laContext` parameter is kept for API-compat with
// the call sites (they already thread a per-call `LAContext` through),
// but we no longer consult it — every interpretation we could drive
// from it has proven to be unreliable on-device.
- (NSString *)codeForGetSecretOSStatus:(OSStatus)status
                              laContext:(__unused LAContext *)laContext {
  return [self codeForOSStatus:status];
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

  // Caller may pre-seed the 32-byte wallet secret by passing lower-case
  // hex (length 64) under `secretHex`. When provided we MUST store those
  // exact bytes so the JS layer can derive the HD seed / mnemonic from
  // the same bytes without triggering a follow-up biometric read during
  // provisioning.
  NSString *secretHex = [options[@"secretHex"] isKindOfClass:[NSString class]]
      ? options[@"secretHex"] : nil;

  dispatch_async(_keychainQueue, ^{
    // Resolve the 32-byte wallet secret.
    //
    // Contract parity with Android (VAL-VAULT-025): the TurboModule spec
    // says that if the caller supplies `secretHex`, those EXACT bytes MUST
    // be stored. Any deviation — wrong length, non-hex character — must
    // REJECT, never silently fall through to CSPRNG-generated entropy.
    // Falling through would create a JS/native secret mismatch: the JS
    // layer derives DID/CEK/mnemonic from the hex it passed in, but the
    // native store would hold different random bytes, so a subsequent
    // `getSecret()` + re-derive would yield a different DID and the
    // wallet would deterministically fail to recover.
    //
    // We therefore distinguish TWO cases:
    //   - `secretHex == nil` (caller did not opt in to pre-seeding) →
    //     generate fresh CSPRNG entropy. This is the only valid fallback.
    //   - `secretHex` is a non-nil NSString → it MUST be exactly
    //     64 lower-case hex characters; anything else rejects with a
    //     deterministic error so the JS layer can surface the mismatch.
    NSMutableData *secretData = [NSMutableData dataWithLength:kBiometricVaultSecretByteLength];
    if (secretHex != nil) {
      if (secretHex.length != kBiometricVaultSecretByteLength * 2) {
        [secretData resetBytesInRange:NSMakeRange(0, secretData.length)];
        reject(kErrVault,
               @"secretHex must be exactly 64 hex characters (32 bytes)",
               nil);
        return;
      }
      uint8_t *bytes = (uint8_t *)secretData.mutableBytes;
      BOOL parseOk = YES;
      for (NSUInteger i = 0; i < kBiometricVaultSecretByteLength; i++) {
        unichar hi = [secretHex characterAtIndex:i * 2];
        unichar lo = [secretHex characterAtIndex:i * 2 + 1];
        int hiVal = -1;
        int loVal = -1;
        if (hi >= '0' && hi <= '9') hiVal = hi - '0';
        else if (hi >= 'a' && hi <= 'f') hiVal = 10 + (hi - 'a');
        else if (hi >= 'A' && hi <= 'F') hiVal = 10 + (hi - 'A');
        if (lo >= '0' && lo <= '9') loVal = lo - '0';
        else if (lo >= 'a' && lo <= 'f') loVal = 10 + (lo - 'a');
        else if (lo >= 'A' && lo <= 'F') loVal = 10 + (lo - 'A');
        if (hiVal < 0 || loVal < 0) {
          parseOk = NO;
          break;
        }
        bytes[i] = (uint8_t)((hiVal << 4) | loVal);
      }
      if (!parseOk) {
        [secretData resetBytesInRange:NSMakeRange(0, secretData.length)];
        reject(kErrVault, @"secretHex is not valid 64-character lower-case hex", nil);
        return;
      }
    } else {
      OSStatus randStatus = SecRandomCopyBytes(kSecRandomDefault,
                                               kBiometricVaultSecretByteLength,
                                               secretData.mutableBytes);
      if (randStatus != errSecSuccess) {
        reject(kErrVault, @"Failed to generate random secret", nil);
        return;
      }
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

    // Non-destructive contract (VAL-VAULT-030): refuse to provision
    // over an existing alias.
    //
    // The pre-fix code path silently issued `SecItemDelete` BEFORE the
    // `SecItemAdd` and had no rollback at all (the delete was
    // unconditional and the add could fail asynchronously after the
    // delete had already taken effect). That pattern destroyed a
    // working wallet whenever:
    //   - LAContext / biometric prompt was cancelled mid-add (rare on
    //     iOS for a `SecItemAdd` with a `BiometryCurrentSet` ACL but
    //     possible if the keychain daemon momentarily refused to add),
    //   - keychain quota was exhausted,
    //   - the ACL became unavailable (e.g. enrollment changed between
    //     the delete and the add — surfaced as `errSecAuthFailed` /
    //     `errSecInteractionNotAllowed` on the add), or
    //   - the process was suspended between the two SecItem calls.
    //
    // The JS layer already pre-checks via `BiometricVault._doInitialize`,
    // but the native API surface should match the JS guarantee so
    // future callers cannot drift from the safe pattern. Callers that
    // intend to overwrite MUST first call `deleteSecret(...)`, which
    // makes the destructive intent visible and auditable.
    {
      NSMutableDictionary *existsQuery = [@{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: kBiometricVaultService,
        (__bridge id)kSecAttrAccount: keyAlias,
        (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
        (__bridge id)kSecReturnAttributes: @YES,
        (__bridge id)kSecReturnData: @NO,
        // Suppress biometric UI on the existence probe — we only need
        // to know whether the item is present, not to read it. A
        // BiometryCurrentSet item resolves as
        // `errSecInteractionNotAllowed` here, which we treat as
        // "exists".
        (__bridge id)kSecUseAuthenticationUI: (__bridge id)kSecUseAuthenticationUIFail,
      } mutableCopy];
      CFTypeRef existsResult = NULL;
      OSStatus existsStatus = SecItemCopyMatching(
          (__bridge CFDictionaryRef)existsQuery, &existsResult);
      if (existsResult != NULL) CFRelease(existsResult);
      if (existsStatus == errSecSuccess ||
          existsStatus == errSecInteractionNotAllowed) {
        // Best-effort zeroize the in-memory secret buffer before
        // returning so the caller-provided / freshly generated bytes
        // never live longer than this scope.
        [secretData resetBytesInRange:NSMakeRange(0, secretData.length)];
        // The ACL was created earlier; release it explicitly because
        // we are NOT about to hand it to `SecItemAdd` via
        // `__bridge_transfer`.
        CFRelease(sacRef);
        reject(kErrAlreadyInitialized,
               @"A biometric secret already exists for this alias; "
               @"delete it explicitly before re-provisioning",
               nil);
        return;
      }
      // Any other status (`errSecItemNotFound`, OS-level errors that
      // we couldn't reliably interpret) — fall through to the add
      // path. `SecItemAdd` will surface a deterministic error if the
      // alias really does exist (`errSecDuplicateItem`); the
      // existence check is belt-and-suspenders, not the primary
      // guard.
    }

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
    } else if (status == errSecDuplicateItem) {
      // Existence pre-check above is a best-effort fast-path; if it
      // somehow missed the existing item (e.g. keychain consistency
      // window) the add itself will surface `errSecDuplicateItem`.
      // Translate to the canonical contract code rather than the
      // generic VAULT_ERROR so the JS layer's UI logic can route to
      // the same "already initialized" branch.
      reject(kErrAlreadyInitialized,
             @"A biometric secret already exists for this alias; "
             @"delete it explicitly before re-provisioning",
             nil);
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
      // Thin passthrough to the shared OSStatus mapping. Historically
      // this branch used `codeForGetSecretOSStatus:laContext:` to try
      // to disambiguate `errSecAuthFailed` into `KEY_INVALIDATED` via
      // a `canEvaluatePolicy` probe, but the signal turned out to be
      // unreliable in practice (retryable Face ID / Touch ID mismatches
      // were routed into the recovery-restore flow). `errSecAuthFailed`
      // now cleanly maps to `AUTH_FAILED` in `codeForOSStatus:`; the
      // real key-invalidation signals on iOS are `errSecItemNotFound`
      // (auto-deleted after enrollment change) and the
      // `errSecInvalidData` / `errSecDecode` family. See VAL-VAULT-023.
      NSString *code = [self codeForGetSecretOSStatus:status laContext:context];
      NSString *message = [NSString stringWithFormat:@"getSecret failed (OSStatus %d)", (int)status];
      reject(code, message, nil);
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
