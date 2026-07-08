#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(HoneyPuttingTrackerPlugin, NSObject)

RCT_EXTERN_METHOD(trackPuttingObjects:(NSString *)videoUri
                  stepMs:(nonnull NSNumber *)stepMs
                  options:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
