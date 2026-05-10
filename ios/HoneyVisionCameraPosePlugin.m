#import <Foundation/Foundation.h>
#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>

#import "honeyswing-Swift.h"

VISION_EXPORT_SWIFT_FRAME_PROCESSOR(HoneyVisionCameraPosePlugin, honeyPoseDetect)

// MARK: - Thin ObjC bridge for grip classification (pass-through only, no business logic)

#import <React/RCTBridgeModule.h>

@interface HoneyGripBridge : NSObject <RCTBridgeModule>
@end

@implementation HoneyGripBridge

RCT_EXPORT_MODULE();

RCT_EXPORT_METHOD(classifyGripFrames:(NSDictionary *)params
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSArray *timestamps = params[@"timestamps"];
  NSArray *wristX = params[@"wristX"];
  NSArray *wristY = params[@"wristY"];
  [HoneyVisionCameraPosePlugin classifyGripFramesWithTimestamps:timestamps
                                                        wristX:wristX
                                                        wristY:wristY
                                                    completion:^(NSArray *results) {
    resolve(results ?: [NSNull null]);
  }];
}

RCT_EXPORT_METHOD(releaseGripBuffer:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  [HoneyVisionCameraPosePlugin releaseGripBuffer];
  resolve(@YES);
}

RCT_EXPORT_METHOD(resetPoseState) {
  [HoneyVisionCameraPosePlugin resetPoseState];
}

@end
