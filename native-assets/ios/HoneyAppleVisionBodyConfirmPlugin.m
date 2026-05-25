#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(HoneyAppleVisionBodyConfirmPlugin, NSObject)

RCT_EXTERN_METHOD(confirmBodyAtVideo:(NSString *)videoUri
                  timestampMs:(nonnull NSNumber *)timestampMs
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
