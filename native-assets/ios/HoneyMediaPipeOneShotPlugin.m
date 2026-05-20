#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(HoneyMediaPipeOneShotPlugin, NSObject)

RCT_EXTERN_METHOD(detectMediaPipeHandInPhoto:(NSString *)photoUri
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
