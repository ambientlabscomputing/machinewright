// Exposes MachinewrightWorkerModule.swift's @objc surface to the classic
// (non-TurboModule) React Native bridge. This project builds with the
// classic architecture (Podfile's `fabric_enabled` is gated on
// RCT_NEW_ARCH_ENABLED, unset for this spike), so RCT_EXTERN_MODULE is the
// correct, simpler registration path — no Codegen spec required.
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(MachinewrightWorkerModule, RCTEventEmitter)

RCT_EXTERN_METHOD(spawn:(NSString *)executablePath
                  args:(NSArray<NSString *> *)args
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(send:(NSString *)base64Payload
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
