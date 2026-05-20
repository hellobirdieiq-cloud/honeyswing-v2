#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(HoneyVisionAppleHandPlugin, NSObject)

RCT_EXTERN_METHOD(detectAppleHandInPhoto:(NSString *)photoUri
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
