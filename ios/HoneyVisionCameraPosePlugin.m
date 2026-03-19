#import <Foundation/Foundation.h>
#import <VisionCamera/FrameProcessorPlugin.h>
#import <VisionCamera/FrameProcessorPluginRegistry.h>

#import "HoneySwingV2-Swift.h"

@interface HoneyVisionCameraPosePlugin (FrameProcessor)
@end

@implementation HoneyVisionCameraPosePlugin (FrameProcessor)

VISION_EXPORT_FRAME_PROCESSOR(HoneyVisionCameraPosePlugin, honeyPoseDetect)

@end
