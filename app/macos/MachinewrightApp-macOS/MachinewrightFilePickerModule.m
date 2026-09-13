#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(MachinewrightFilePickerModule, NSObject)

RCT_EXTERN_METHOD(pickProjectDirectory:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(pickFile:(NSString *)startDirectory
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
