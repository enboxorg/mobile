#import "RCTNativeSecureStorage.h"
#import <Security/Security.h>

static NSString *const kServiceName = @"org.enbox.mobile.secure";

@implementation RCTNativeSecureStorage {
  dispatch_queue_t _keychainQueue;
}

- (instancetype)init {
  if (self = [super init]) {
    _keychainQueue = dispatch_queue_create("org.enbox.mobile.keychain", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeSecureStorageSpecJSI>(params);
}

+ (NSString *)moduleName {
  return @"NativeSecureStorage";
}

#pragma mark - Keychain helpers

- (NSMutableDictionary *)keychainQueryForKey:(NSString *)key {
  return [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: kServiceName,
    (__bridge id)kSecAttrAccount: key,
    (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
  } mutableCopy];
}

#pragma mark - NativeSecureStorageSpec

- (void)getItem:(NSString *)key
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_keychainQueue, ^{
    NSMutableDictionary *query = [self keychainQueryForKey:key];
    query[(__bridge id)kSecReturnData] = @YES;
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;

    CFDataRef dataRef = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, (CFTypeRef *)&dataRef);

    if (status == errSecSuccess && dataRef != NULL) {
      NSData *data = (__bridge_transfer NSData *)dataRef;
      NSString *value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
      resolve(value);
    } else if (status == errSecItemNotFound) {
      resolve([NSNull null]);
    } else {
      reject(@"KEYCHAIN_ERROR", @"Failed to read from Keychain", nil);
    }
  });
}

- (void)setItem:(NSString *)key
          value:(NSString *)value
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_keychainQueue, ^{
    NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
    NSMutableDictionary *query = [self keychainQueryForKey:key];

    // Delete-then-add is the simplest atomic pattern for Keychain upsert
    SecItemDelete((__bridge CFDictionaryRef)query);

    query[(__bridge id)kSecValueData] = data;
    OSStatus status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);

    if (status == errSecSuccess) {
      resolve(nil);
    } else {
      reject(@"KEYCHAIN_ERROR", [NSString stringWithFormat:@"Failed to write to Keychain (status %d)", (int)status], nil);
    }
  });
}

- (void)deleteItem:(NSString *)key
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_keychainQueue, ^{
    NSMutableDictionary *query = [self keychainQueryForKey:key];
    OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);

    if (status == errSecSuccess || status == errSecItemNotFound) {
      resolve(nil);
    } else {
      reject(@"KEYCHAIN_ERROR", @"Failed to delete from Keychain", nil);
    }
  });
}

@end
