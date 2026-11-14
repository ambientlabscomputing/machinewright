#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(MachinewrightFilePickerModule, NSObject)

RCT_EXTERN_METHOD(pickProjectDirectory:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(pickFile:(NSString *)startDirectory
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(pickDirectory:(NSString *)prompt
                  message:(NSString *)message
                  startDirectory:(NSString *)startDirectory
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(pickSaveFile:(NSString *)suggestedName
                  startDirectory:(NSString *)startDirectory
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(revealInFinder:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
