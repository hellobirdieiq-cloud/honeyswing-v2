import Foundation
import React
import CoreML
import AVFoundation
import CoreImage
import UIKit

@objc(HoneyRtmwOneShotPlugin)
class HoneyRtmwOneShotPlugin: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  private static let inputWidth = 192
  private static let inputHeight = 256
  private static let numKeypoints = 133
  private static let simccSplitRatio: Float = 2.0

  private static let modelLock = NSLock()
  private static var model: MLModel?
  private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

  private static func sharedModel() -> (MLModel?, String?) {
    modelLock.lock()
    defer { modelLock.unlock() }
    if let existing = model { return (existing, nil) }
    guard let url = Bundle.main.url(forResource: "rtmw_l_256x192", withExtension: "mlmodelc") else {
      return (nil, "model_load_failed: rtmw_l_256x192.mlmodelc not found in bundle")
    }
    do {
      let config = MLModelConfiguration()
      config.computeUnits = .cpuAndNeuralEngine
      let m = try MLModel(contentsOf: url, configuration: config)
      model = m
      return (m, nil)
    } catch {
      return (nil, "model_load_failed: \(error.localizedDescription)")
    }
  }

  @objc(extractRtmwFromVideo:atTimestampsMs:boundingBox:resolver:rejecter:)
  func extractRtmwFromVideo(_ videoUri: NSString,
                            atTimestampsMs: NSArray,
                            boundingBox: NSDictionary?,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      let (modelOpt, initErr) = Self.sharedModel()
      guard let mlModel = modelOpt else {
        DispatchQueue.main.async { reject("model_load_failed", initErr ?? "unknown", nil) }
        return
      }

      guard let url = URL(string: videoUri as String) else {
        DispatchQueue.main.async {
          reject("invalid_video", "Could not parse video URI: \(videoUri)", nil)
        }
        return
      }

      let asset = AVURLAsset(url: url)

      // TEMP DIAGNOSTIC — read AVAssetTrack.nominalFrameRate to measure
      // achieved capture FPS vs the requested 240. Optional .first being nil
      // is the sole read-failure signal; a real 0.0 reading is diagnostic
      // data and must reach JS, so do NOT collapse it with `> 0`.
      //
      // Also read the video track's true duration (timeRange.duration) and
      // a true encoded frame count (AVAssetReader passthrough walk). These
      // two together let Supabase compute frames/duration as a check on
      // nominalFrameRate. NSNull on read failure; a real 0 propagates.
      let captureFpsValue: Any
      let videoDurationMsValue: Any
      let videoFrameCountValue: Any
      if let track = asset.tracks(withMediaType: .video).first {
        captureFpsValue = NSNumber(value: track.nominalFrameRate)

        let seconds = CMTimeGetSeconds(track.timeRange.duration)
        if seconds.isNaN || seconds < 0 {
          videoDurationMsValue = NSNull()
        } else {
          videoDurationMsValue = NSNumber(value: seconds * 1000.0)
        }

        var frameCountResult: Any = NSNull()
        do {
          let reader = try AVAssetReader(asset: asset)
          let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
          if reader.canAdd(output) {
            reader.add(output)
            if reader.startReading() {
              var count = 0
              while let _ = output.copyNextSampleBuffer() {
                count += 1
              }
              if reader.status == .completed {
                frameCountResult = NSNumber(value: count)
              }
            }
          }
        } catch {
          // initializer threw — keep NSNull
        }
        videoFrameCountValue = frameCountResult
      } else {
        captureFpsValue = NSNull()
        videoDurationMsValue = NSNull()
        videoFrameCountValue = NSNull()
      }

      let generator = AVAssetImageGenerator(asset: asset)
      generator.appliesPreferredTrackTransform = true
      generator.requestedTimeToleranceBefore = .zero
      generator.requestedTimeToleranceAfter = .zero

      guard let timestamps = atTimestampsMs as? [NSNumber] else {
        DispatchQueue.main.async {
          reject("invalid_timestamps", "atTimestampsMs is not a number array", nil)
        }
        return
      }

      var frames: [[String: Any]] = []

      for ts in timestamps {
        let tsMs = ts.doubleValue
        let cmTime = CMTime(value: CMTimeValue(tsMs), timescale: 1000)
        let frameStart = DispatchTime.now()

        guard let fullImage = try? generator.copyCGImage(at: cmTime, actualTime: nil) else {
          DispatchQueue.main.async {
            reject("frame_extract_failed", "copyCGImage failed at \(tsMs)ms", nil)
          }
          return
        }

        // Crop to person bbox if provided (normalized 0-1 fractions); else use full frame.
        let cgImage: CGImage
        if let bbox = boundingBox,
           let bx = (bbox["x"] as? NSNumber)?.doubleValue,
           let by = (bbox["y"] as? NSNumber)?.doubleValue,
           let bw = (bbox["w"] as? NSNumber)?.doubleValue,
           let bh = (bbox["h"] as? NSNumber)?.doubleValue {
          let fw = Double(fullImage.width), fh = Double(fullImage.height)
          let cropRect = CGRect(x: bx * fw, y: by * fh, width: bw * fw, height: bh * fh)
            .integral
            .intersection(CGRect(x: 0, y: 0, width: fw, height: fh))
          cgImage = fullImage.cropping(to: cropRect) ?? fullImage
        } else {
          cgImage = fullImage
        }

        let origWidth = cgImage.width
        let origHeight = cgImage.height

        guard let pixelBuffer = Self.resizeToInput(cgImage) else {
          DispatchQueue.main.async {
            reject("resize_failed", "resize failed at \(tsMs)ms", nil)
          }
          return
        }

        guard let inputArray = Self.pixelBufferToNCHW(pixelBuffer) else {
          DispatchQueue.main.async {
            reject("tensor_build_failed", "NCHW build failed at \(tsMs)ms", nil)
          }
          return
        }

        do {
          let provider = try MLDictionaryFeatureProvider(dictionary: ["image": inputArray])
          let output = try mlModel.prediction(from: provider)
          guard let simccX = output.featureValue(for: "simcc_x")?.multiArrayValue,
                let simccY = output.featureValue(for: "simcc_y")?.multiArrayValue else {
            DispatchQueue.main.async {
              reject("output_missing", "simcc_x/simcc_y absent at \(tsMs)ms", nil)
            }
            return
          }

          let keypoints = Self.decodeSimCC(simccX: simccX, simccY: simccY,
                                           origWidth: origWidth, origHeight: origHeight)
          let frameEnd = DispatchTime.now()
          let extractionMs = Double(frameEnd.uptimeNanoseconds - frameStart.uptimeNanoseconds) / 1_000_000.0

          frames.append([
            "timestampMs": tsMs,
            "keypoints": keypoints,
            "extractionMs": extractionMs,
            "frameWidth": origWidth,
            "frameHeight": origHeight,
            "captureFps": captureFpsValue,
            "videoDurationMs": videoDurationMsValue,
            "videoFrameCount": videoFrameCountValue,
          ])
        } catch {
          DispatchQueue.main.async {
            reject("inference_failed",
                   "prediction failed at \(tsMs)ms: \(error.localizedDescription)", nil)
          }
          return
        }
      }

      DispatchQueue.main.async { resolve(frames) }
    }
  }

  private static func resizeToInput(_ cgImage: CGImage) -> CVPixelBuffer? {
    let ciImage = CIImage(cgImage: cgImage)
    let scaleX = CGFloat(inputWidth) / CGFloat(cgImage.width)
    let scaleY = CGFloat(inputHeight) / CGFloat(cgImage.height)

    guard let filter = CIFilter(name: "CILanczosScaleTransform") else { return nil }
    filter.setValue(ciImage, forKey: kCIInputImageKey)
    filter.setValue(scaleY, forKey: kCIInputScaleKey)
    filter.setValue(scaleX / scaleY, forKey: kCIInputAspectRatioKey)
    guard let scaled = filter.outputImage else { return nil }

    var pb: CVPixelBuffer?
    let attrs: [String: Any] = [
      kCVPixelBufferCGImageCompatibilityKey as String: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ]
    CVPixelBufferCreate(kCFAllocatorDefault, inputWidth, inputHeight,
                        kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pb)
    guard let buffer = pb else { return nil }

    let rect = CGRect(x: 0, y: 0, width: inputWidth, height: inputHeight)
    ciContext.render(scaled, to: buffer, bounds: rect, colorSpace: CGColorSpaceCreateDeviceRGB())
    return buffer
  }

  private static func pixelBufferToNCHW(_ pixelBuffer: CVPixelBuffer) -> MLMultiArray? {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    let ptr = base.assumingMemoryBound(to: UInt8.self)

    guard let array = try? MLMultiArray(shape: [1, 3, NSNumber(value: inputHeight), NSNumber(value: inputWidth)],
                                        dataType: .float32) else { return nil }
    let dataPtr = array.dataPointer.assumingMemoryBound(to: Float32.self)

    let H = inputHeight, W = inputWidth
    let planeR = 0 * H * W
    let planeG = 1 * H * W
    let planeB = 2 * H * W

    for y in 0..<H {
      let rowStart = y * bytesPerRow
      for x in 0..<W {
        let px = rowStart + x * 4
        let b = Float32(ptr[px + 0])
        let g = Float32(ptr[px + 1])
        let r = Float32(ptr[px + 2])
        let hw = y * W + x
        dataPtr[planeR + hw] = r
        dataPtr[planeG + hw] = g
        dataPtr[planeB + hw] = b
      }
    }
    return array
  }

  private static func decodeSimCC(simccX: MLMultiArray, simccY: MLMultiArray,
                                  origWidth: Int, origHeight: Int) -> [[String: Any]] {
    let xBins = simccX.shape[2].intValue
    let yBins = simccY.shape[2].intValue
    let xPtr = simccX.dataPointer.assumingMemoryBound(to: Float32.self)
    let yPtr = simccY.dataPointer.assumingMemoryBound(to: Float32.self)

    var keypoints: [[String: Any]] = []
    keypoints.reserveCapacity(numKeypoints)

    for k in 0..<numKeypoints {
      let xRow = k * xBins
      var xArgmax = 0
      var xMax = -Float32.greatestFiniteMagnitude
      for b in 0..<xBins {
        let v = xPtr[xRow + b]
        if v > xMax { xMax = v; xArgmax = b }
      }
      let yRow = k * yBins
      var yArgmax = 0
      var yMax = -Float32.greatestFiniteMagnitude
      for b in 0..<yBins {
        let v = yPtr[yRow + b]
        if v > yMax { yMax = v; yArgmax = b }
      }

      let xInput = Float32(xArgmax) / simccSplitRatio
      let yInput = Float32(yArgmax) / simccSplitRatio
      let xNorm = xInput / Float32(inputWidth)
      let yNorm = yInput / Float32(inputHeight)

      keypoints.append([
        "x": xNorm * Float32(origWidth),
        "y": yNorm * Float32(origHeight),
        "confidence": max(xMax, yMax),
      ])
    }
    return keypoints
  }
}
