#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(HoneyRtmwOneShotPlugin, NSObject)

RCT_EXTERN_METHOD(extractRtmwFromVideo:(NSString *)videoUri
                  atTimestampsMs:(NSArray *)atTimestampsMs
                  boundingBox:(NSDictionary *)boundingBox
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
