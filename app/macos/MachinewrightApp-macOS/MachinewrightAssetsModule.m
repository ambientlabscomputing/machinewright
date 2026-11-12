#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(MachinewrightAssetsModule, NSObject)

RCT_EXTERN_METHOD(bundledAssetURL:(NSString *)relativePath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(readTextFile:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(meshFileURL:(NSString *)path
                  expectedDigest:(NSString *)expectedDigest
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(digestFile:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(writeTextFileAtomically:(NSString *)path
                  contents:(NSString *)contents
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(listDirectory:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(listFilesRecursive:(NSString *)root
                  ignoredNames:(NSArray<NSString *> *)ignoredNames
                  limit:(nonnull NSNumber *)limit
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(searchInFiles:(NSString *)root
                  query:(NSString *)query
                  caseSensitive:(BOOL)caseSensitive
                  ignoredNames:(NSArray<NSString *> *)ignoredNames
                  maxResults:(nonnull NSNumber *)maxResults
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
