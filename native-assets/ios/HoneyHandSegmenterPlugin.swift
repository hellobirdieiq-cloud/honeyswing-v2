import Foundation
import React
import Vision
import MediaPipeTasksVision
import UIKit
import CoreImage
import CoreVideo

@objc(HoneyHandSegmenterPlugin)
class HoneyHandSegmenterPlugin: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  private static let ciContext = CIContext(options: nil)

  // ImageSegmenter is expensive to construct; cache one instance per process.
  private static let segmenterLock = NSLock()
  private static var imageSegmenter: ImageSegmenter?

  // EXTERNAL ASSUMPTION: VNHumanHandPoseObservation joint confidences below 0.3
  // are visually noisy. Dropping them natively keeps the JS overlay clean and
  // matches the threshold the grip server uses for incomplete-hand rejection
  // (supabase/functions/classify-grip/index.ts).
  private static let HAND_JOINT_CONFIDENCE_MIN: Float = 0.3

  // Copied verbatim from HoneyVisionAppleHandPlugin.swift:15-37.
  // FOLLOW-UP: extract into a shared file once the locked-file constraint lifts.
  private static let handJointNames: [(VNHumanHandPoseObservation.JointName, String)] = [
    (.wrist, "wrist"),
    (.thumbCMC, "thumbCMC"),
    (.thumbMP, "thumbMP"),
    (.thumbIP, "thumbIP"),
    (.thumbTip, "thumbTip"),
    (.indexMCP, "indexMCP"),
    (.indexPIP, "indexPIP"),
    (.indexDIP, "indexDIP"),
    (.indexTip, "indexTip"),
    (.middleMCP, "middleMCP"),
    (.middlePIP, "middlePIP"),
    (.middleDIP, "middleDIP"),
    (.middleTip, "middleTip"),
    (.ringMCP, "ringMCP"),
    (.ringPIP, "ringPIP"),
    (.ringDIP, "ringDIP"),
    (.ringTip, "ringTip"),
    (.littleMCP, "littleMCP"),
    (.littlePIP, "littlePIP"),
    (.littleDIP, "littleDIP"),
    (.littleTip, "littleTip"),
  ]

  private static func sharedImageSegmenter() throws -> ImageSegmenter {
    segmenterLock.lock()
    defer { segmenterLock.unlock() }
    if let existing = imageSegmenter { return existing }

    guard let modelPath = Bundle.main.path(
      forResource: "selfie_segmenter", ofType: "tflite"
    ) else {
      throw NSError(domain: "HoneyHandSegmenter", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "selfie_segmenter.tflite not in bundle"])
    }
    let opts = ImageSegmenterOptions()
    opts.baseOptions.modelAssetPath = modelPath
    opts.runningMode = .image
    opts.shouldOutputCategoryMask = true
    opts.shouldOutputConfidenceMasks = false
    let seg = try ImageSegmenter(options: opts)
    imageSegmenter = seg
    return seg
  }

  // MARK: - S6 probe (kept for future debugging; plan: "deletable later")

  @objc(probeMediaPipeInit:rejecter:)
  func probeMediaPipeInit(_ resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        _ = try Self.sharedImageSegmenter()
        DispatchQueue.main.async { resolve(["ok": true]) }
      } catch {
        DispatchQueue.main.async {
          reject("init_failed",
                 "ImageSegmenter init failed: \(error.localizedDescription)", nil)
        }
      }
    }
  }

  // MARK: - Full segmentation

  @objc(segmentHandInPhoto:resolver:rejecter:)
  func segmentHandInPhoto(_ photoUri: NSString,
                          resolver resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.global(qos: .userInitiated).async {
      guard let url = URL(string: photoUri as String),
            let data = try? Data(contentsOf: url),
            let rawImage = UIImage(data: data) else {
        DispatchQueue.main.async {
          reject("invalid_photo",
                 "Could not load image from URI: \(photoUri)", nil)
        }
        return
      }

      // Normalize the captured photo so its pixel layout matches display
      // orientation (imageOrientation == .up). After this every downstream
      // surface — Vision cgImage, MediaPipe MPImage, returned mask PNGs, and
      // the normalizedPhotoUri PNG — lives in the SAME coordinate space, so
      // RN can overlay them without any further rotation reasoning.
      let uiImage = Self.normalizedUpImage(rawImage)
      guard let cgImage = uiImage.cgImage else {
        DispatchQueue.main.async {
          reject("invalid_photo",
                 "Normalized image has no cgImage: \(photoUri)", nil)
        }
        return
      }

      print("[HHS] raw.imageOrientation=\(rawImage.imageOrientation.rawValue) " +
            "raw.size=\(rawImage.size.width)x\(rawImage.size.height) " +
            "normalized.imageOrientation=\(uiImage.imageOrientation.rawValue) " +
            "normalized.size=\(uiImage.size.width)x\(uiImage.size.height) " +
            "normalized.cgImage=\(cgImage.width)x\(cgImage.height)")

      let normalizedPhotoUri = Self.saveNormalizedPNG(uiImage)
      print("[HHS] normalized: photoUri=\(normalizedPhotoUri ?? "<save_failed>")")

      let group = DispatchGroup()

      // Per-method outputs — written from their own queues, read after group.wait().
      var appleSubjectMaskUri: String? = nil
      var applePersonMaskUri: String? = nil
      var mediapipeMaskUri: String? = nil
      var appleSubjectError: String? = nil
      var applePersonError: String? = nil
      var mediapipeError: String? = nil
      var appleHandPose: [[String: Any]] = []
      var appleHandPoseError: String? = nil

      // ---- Apple Subject (iOS 17+ mask) + Apple Hand Pose (iOS 14+) ----
      group.enter()
      DispatchQueue.global(qos: .userInitiated).async {
        defer { group.leave() }

        // Build the handler once. Hand request runs unconditionally; mask
        // request is appended only on iOS 17+. Single perform() call
        // guarantees both requests consume an identical buffer.
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

        let handReq = VNDetectHumanHandPoseRequest()
        handReq.maximumHandCount = 1

        var requests: [VNRequest] = [handReq]

        var maskReq: VNGenerateForegroundInstanceMaskRequest? = nil
        if #available(iOS 17, *) {
          let mReq = VNGenerateForegroundInstanceMaskRequest()
          requests.append(mReq)
          maskReq = mReq
        } else {
          appleSubjectError = "ios17_unavailable"
        }

        // Single perform — if this throws, BOTH requests are unfulfilled.
        // Record errors on each field; do not abort the closure so the hand
        // drain below still runs (it will just find nil results and emit []).
        do {
          try handler.perform(requests)
        } catch {
          if appleSubjectError == nil {
            appleSubjectError = "vn_subject_failed: \(error.localizedDescription)"
          }
          appleHandPoseError = "vn_hand_failed: \(error.localizedDescription)"
        }

        // ---- Drain mask result (iOS 17+ only) ----
        if #available(iOS 17, *), let req = maskReq {
          do {
            if let observation = req.results?.first {
              let instances = observation.allInstances
              if instances.isEmpty {
                if appleSubjectError == nil { appleSubjectError = "no foreground detected" }
              } else {
                let maskBuffer = try observation.generateScaledMaskForImage(
                  forInstances: instances, from: handler)
                print("[HHS][subj] maskBuffer=\(CVPixelBufferGetWidth(maskBuffer))x\(CVPixelBufferGetHeight(maskBuffer)) " +
                      "fmt=\(CVPixelBufferGetPixelFormatType(maskBuffer))")
                if let tinted = Self.tintMaskAndEncode(
                  maskBuffer: maskBuffer,
                  tint: CIColor(red: 0, green: 1, blue: 1),  // cyan
                  filenamePrefix: "subj"
                ) {
                  appleSubjectMaskUri = tinted
                } else {
                  if appleSubjectError == nil { appleSubjectError = "encode_failed" }
                }
              }
            } else {
              if appleSubjectError == nil { appleSubjectError = "no foreground detected" }
            }
          } catch {
            if appleSubjectError == nil {
              appleSubjectError = "vn_subject_failed: \(error.localizedDescription)"
            }
          }
        }

        // ---- Drain hand pose result (always, even pre-iOS-17) ----
        // recognizedPoint(_:) THROWS for undetected joints — try? skips on
        // failure so one bad joint can't abort the whole hand.
        let handObservations = handReq.results ?? []
        var hands: [[String: Any]] = []
        for obs in handObservations {
          var joints: [String: [String: Any]] = [:]
          for (jointName, stringKey) in Self.handJointNames {
            guard let point = try? obs.recognizedPoint(jointName) else { continue }
            if point.confidence < Self.HAND_JOINT_CONFIDENCE_MIN { continue }
            joints[stringKey] = [
              "x": point.location.x,
              "y": point.location.y,
              "confidence": point.confidence,
            ]
          }
          let chirality: String = {
            switch obs.chirality {
            case .left: return "left"
            case .right: return "right"
            case .unknown: return "unknown"
            @unknown default: return "unknown"
            }
          }()
          hands.append([
            "chirality": chirality,
            "score": obs.confidence,
            "joints": joints,
          ])
        }
        appleHandPose = hands
      }

      // ---- Apple Person ----
      group.enter()
      DispatchQueue.global(qos: .userInitiated).async {
        defer { group.leave() }
        do {
          let req = VNGeneratePersonSegmentationRequest()
          req.qualityLevel = .accurate
          req.outputPixelFormat = kCVPixelFormatType_OneComponent8
          let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
          try handler.perform([req])
          guard let obs = req.results?.first else {
            applePersonError = "no person detected"
            return
          }
          let maskBuffer = obs.pixelBuffer
          print("[HHS][pers] maskBuffer=\(CVPixelBufferGetWidth(maskBuffer))x\(CVPixelBufferGetHeight(maskBuffer)) " +
                "fmt=\(CVPixelBufferGetPixelFormatType(maskBuffer))")
          guard let tinted = Self.tintMaskAndEncode(
            maskBuffer: maskBuffer,
            tint: CIColor(red: 1, green: 0, blue: 1),  // magenta
            filenamePrefix: "pers"
          ) else {
            applePersonError = "encode_failed"
            return
          }
          applePersonMaskUri = tinted
        } catch {
          applePersonError = "vn_person_failed: \(error.localizedDescription)"
        }
      }

      // ---- MediaPipe Image Segmenter ----
      group.enter()
      DispatchQueue.global(qos: .userInitiated).async {
        defer { group.leave() }
        do {
          let segmenter = try Self.sharedImageSegmenter()
          // uiImage is already normalized to .up, so MPImage(uiImage:) sees a
          // display-oriented image and the returned mask is in the same frame.
          let mpImage = try MPImage(uiImage: uiImage)
          let result = try segmenter.segment(image: mpImage)
          guard let categoryMask = result.categoryMask else {
            mediapipeError = "no_category_mask"
            return
          }
          let width = categoryMask.width
          let height = categoryMask.height
          print("[HHS][mp] categoryMask=\(width)x\(height)")
          guard let maskBuffer = Self.makeBinaryAlphaBuffer(
            mpMask: categoryMask, width: Int(width), height: Int(height)
          ) else {
            mediapipeError = "buffer_alloc_failed"
            return
          }
          print("[HHS][mp] alphaBuffer=\(CVPixelBufferGetWidth(maskBuffer))x\(CVPixelBufferGetHeight(maskBuffer))")
          guard let tinted = Self.encodeTintedMask(
            ciMask: CIImage(cvPixelBuffer: maskBuffer),
            tint: CIColor(red: 0, green: 1, blue: 0),  // lime
            filenamePrefix: "mp"
          ) else {
            mediapipeError = "encode_failed"
            return
          }
          mediapipeMaskUri = tinted
        } catch {
          mediapipeError = "mediapipe_failed: \(error.localizedDescription)"
        }
      }

      group.wait()

      // Reject only if all three failed AND we couldn't even save the normalized photo.
      if appleSubjectMaskUri == nil && applePersonMaskUri == nil && mediapipeMaskUri == nil {
        DispatchQueue.main.async {
          reject("all_methods_failed",
                 "All segmentation methods failed: subject=\(appleSubjectError ?? "?"); person=\(applePersonError ?? "?"); mediapipe=\(mediapipeError ?? "?")",
                 nil)
        }
        return
      }

      var resultDict: [String: Any] = [
        "normalizedPhotoUri": normalizedPhotoUri as Any,
        "appleSubjectMaskUri": appleSubjectMaskUri as Any,
        "applePersonMaskUri": applePersonMaskUri as Any,
        "mediapipeMaskUri": mediapipeMaskUri as Any,
        "appleHandPose": appleHandPose,
      ]
      if let e = appleSubjectError { resultDict["appleSubjectError"] = e }
      if let e = applePersonError { resultDict["applePersonError"] = e }
      if let e = mediapipeError { resultDict["mediapipeError"] = e }
      if let e = appleHandPoseError { resultDict["appleHandPoseError"] = e }

      DispatchQueue.main.async { resolve(resultDict) }
    }
  }

  // MARK: - Helpers

  /// Re-render the UIImage so its pixel buffer is in display orientation
  /// (imageOrientation == .up). Eliminates the need to pass orientation to
  /// Vision and the need to rotate returned masks — everything downstream is
  /// in the same coordinate space.
  private static func normalizedUpImage(_ image: UIImage) -> UIImage {
    if image.imageOrientation == .up { return image }
    let format = image.imageRendererFormat
    let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: image.size))
    }
  }

  /// Write the normalized image to a temp PNG and return its file:// URI.
  /// JS uses this as the displayed photo so it shares a coordinate space with
  /// the mask PNGs.
  private static func saveNormalizedPNG(_ image: UIImage) -> String? {
    guard let png = image.pngData() else { return nil }
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("hhseg-norm-\(UUID().uuidString).png")
    do {
      try png.write(to: url)
      return url.absoluteString
    } catch {
      print("[HHS] normalized PNG write failed: \(error.localizedDescription)")
      return nil
    }
  }

  /// Verify Vision mask buffer dimensions/format, then tint + encode.
  /// No orientation arg — input cgImage was already normalized to .up before
  /// the Vision request, so the mask is already in display orientation.
  private static func tintMaskAndEncode(maskBuffer: CVPixelBuffer,
                                        tint: CIColor,
                                        filenamePrefix: String) -> String? {
    let w = CVPixelBufferGetWidth(maskBuffer)
    let h = CVPixelBufferGetHeight(maskBuffer)
    let fmt = CVPixelBufferGetPixelFormatType(maskBuffer)
    if w <= 0 || h <= 0 {
      print("[HHS] reject mask: invalid dims \(w)x\(h)")
      return nil
    }
    let acceptable: Set<OSType> = [
      kCVPixelFormatType_OneComponent8,
      kCVPixelFormatType_OneComponent32Float,
      kCVPixelFormatType_OneComponent16Half,
    ]
    if !acceptable.contains(fmt) {
      print("[HHS] mask format \(fmt) not in accepted set — proceeding anyway")
    }
    let ciMask = CIImage(cvPixelBuffer: maskBuffer)
    print("[HHS][\(filenamePrefix)] mask extent=\(ciMask.extent.width)x\(ciMask.extent.height)")
    return encodeTintedMask(ciMask: ciMask, tint: tint, filenamePrefix: filenamePrefix)
  }

  /// Composite a colored fill onto transparent background using the mask as alpha,
  /// render to CGImage, encode PNG, write to NSTemporaryDirectory, return file:// URI.
  private static func encodeTintedMask(ciMask: CIImage,
                                       tint: CIColor,
                                       filenamePrefix: String) -> String? {
    let extent = ciMask.extent
    if extent.isEmpty || extent.isInfinite {
      print("[HHS] encodeTintedMask: invalid extent \(extent)")
      return nil
    }
    let solid = CIImage(color: tint).cropped(to: extent)
    let clear = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 0)).cropped(to: extent)
    guard let blend = CIFilter(name: "CIBlendWithMask") else { return nil }
    blend.setValue(solid, forKey: kCIInputImageKey)
    blend.setValue(clear, forKey: kCIInputBackgroundImageKey)
    blend.setValue(ciMask, forKey: "inputMaskImage")
    guard let output = blend.outputImage,
          let cg = ciContext.createCGImage(output, from: extent) else {
      return nil
    }
    let ui = UIImage(cgImage: cg)
    guard let png = ui.pngData() else { return nil }
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("hhseg-\(filenamePrefix)-\(UUID().uuidString).png")
    do {
      try png.write(to: url)
      return url.absoluteString
    } catch {
      print("[HHS] PNG write failed: \(error.localizedDescription)")
      return nil
    }
  }

  /// Convert MediaPipe MPMask (single-channel category indices) into a binary
  /// OneComponent8 CVPixelBuffer suitable for use as a CIImage alpha mask.
  /// selfie_segmenter emits class 0 = person (foreground), class 255 = background.
  private static func makeBinaryAlphaBuffer(mpMask: Mask, width: Int, height: Int) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    let attrs = [
      kCVPixelBufferCGImageCompatibilityKey: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey: true,
    ] as CFDictionary
    let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                                     kCVPixelFormatType_OneComponent8,
                                     attrs, &buffer)
    guard status == kCVReturnSuccess, let pb = buffer else { return nil }
    CVPixelBufferLockBaseAddress(pb, [])
    defer { CVPixelBufferUnlockBaseAddress(pb, []) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pb)
    let dst = base.assumingMemoryBound(to: UInt8.self)
    let src = mpMask.uint8Data
    for y in 0..<height {
      let dstRow = dst + (y * bytesPerRow)
      let srcRow = src + (y * width)
      for x in 0..<width {
        dstRow[x] = srcRow[x] == 0 ? 255 : 0
      }
    }
    return pb
  }
}
