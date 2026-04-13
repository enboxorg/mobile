#import "RCTNativeCrypto.h"
#import <CommonCrypto/CommonDigest.h>
#import <CommonCrypto/CommonKeyDerivation.h>
#import <Security/SecRandom.h>

@implementation RCTNativeCrypto

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeCryptoSpecJSI>(params);
}

+ (NSString *)moduleName {
  return @"NativeCrypto";
}

#pragma mark - Helpers

- (NSString *)hexFromBytes:(const uint8_t *)bytes length:(NSInteger)length {
  NSMutableString *hex = [NSMutableString stringWithCapacity:length * 2];
  for (NSInteger i = 0; i < length; i++) {
    [hex appendFormat:@"%02x", bytes[i]];
  }
  return hex;
}

#pragma mark - NativeCryptoSpec

- (void)sha256:(NSString *)data
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject {
  NSData *inputData = [data dataUsingEncoding:NSUTF8StringEncoding];
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(inputData.bytes, (CC_LONG)inputData.length, digest);
  resolve([self hexFromBytes:digest length:CC_SHA256_DIGEST_LENGTH]);
}

- (void)pbkdf2:(NSString *)password
          salt:(NSString *)salt
    iterations:(double)iterations
     keyLength:(double)keyLength
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject {
  NSData *passwordData = [password dataUsingEncoding:NSUTF8StringEncoding];
  NSData *saltData = [salt dataUsingEncoding:NSUTF8StringEncoding];
  NSInteger keyLen = (NSInteger)keyLength;

  if (keyLen <= 0 || keyLen > 128) {
    reject(@"CRYPTO_ERROR", @"Key length must be between 1 and 128", nil);
    return;
  }

  NSMutableData *derivedKey = [NSMutableData dataWithLength:keyLen];

  int status = CCKeyDerivationPBKDF(
    kCCPBKDF2,
    passwordData.bytes, passwordData.length,
    (const uint8_t *)saltData.bytes, saltData.length,
    kCCPRFHmacAlgSHA256,
    (uint)iterations,
    derivedKey.mutableBytes, keyLen
  );

  if (status != kCCSuccess) {
    reject(@"CRYPTO_ERROR", @"PBKDF2 derivation failed", nil);
    return;
  }

  resolve([self hexFromBytes:(const uint8_t *)derivedKey.bytes length:keyLen]);
}

- (void)randomBytes:(double)length
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject {
  NSInteger byteCount = (NSInteger)length;

  if (byteCount <= 0 || byteCount > 1024) {
    reject(@"CRYPTO_ERROR", @"Byte count must be between 1 and 1024", nil);
    return;
  }

  NSMutableData *data = [NSMutableData dataWithLength:byteCount];
  OSStatus status = SecRandomCopyBytes(kSecRandomDefault, byteCount, data.mutableBytes);

  if (status != errSecSuccess) {
    reject(@"CRYPTO_ERROR", @"Failed to generate random bytes", nil);
    return;
  }

  resolve([self hexFromBytes:(const uint8_t *)data.bytes length:byteCount]);
}

@end
