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

@end
