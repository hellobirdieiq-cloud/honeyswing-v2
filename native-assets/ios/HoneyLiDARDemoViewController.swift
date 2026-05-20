import Foundation
import UIKit
import ARKit
import SceneKit
import CoreImage
import CoreImage.CIFilterBuiltins
import Metal

final class HoneyLiDARDemoViewController: UIViewController {

  // MARK: - Tunable constants

  // EXTERNAL ASSUMPTION — tunable for demo
  private static let depthWindowMin: Float = 0.20
  // EXTERNAL ASSUMPTION — tunable for demo
  private static let depthWindowMax: Float = 0.50
  // EXTERNAL ASSUMPTION — tunable for demo
  private static let outOfWindowGray: CGFloat = 0.15
  // EXTERNAL ASSUMPTION — tunable for demo
  private static let temporalSmoothingAlpha: Float = 0.15
  // EXTERNAL ASSUMPTION — tunable for demo
  private static let lutWidth: Int = 2048
  // EXTERNAL ASSUMPTION — tunable for demo
  private static let legendRefreshHz: Double = 5.0
  // EXTERNAL ASSUMPTION — tunable for demo
  private static let minHighConfidenceLevel: UInt8 = 1
  // EXTERNAL ASSUMPTION — tunable for demo: upsample factor from 256x192 native
  private static let upsampleScale: CGFloat = 4.0

  private static let goldColor = UIColor(red: 245/255.0, green: 166/255.0, blue: 35/255.0, alpha: 1.0)

  // MARK: - UI

  private let arView = ARSCNView(frame: .zero)
  private let depthImageView = UIImageView(frame: .zero)
  private let closeButton = UIButton(type: .system)
  private let captureButton = UIButton(type: .system)
  private let badgeLabel = UILabel()
  private let nearLabel = UILabel()
  private let farLabel = UILabel()
  private let rangeLabel = UILabel()
  private let legendStack = UIStackView()

  // MARK: - State

  private var isFrozen = false
  private var prevMinMaxSeeded = false
  private var smoothedMin: Float = 0
  private var smoothedMax: Float = 1
  private var legendTimer: Timer?

  // Pre-allocated 16-byte buffers for CIAreaMinMaxRed renders (.RGBAf is 16 B/pixel).
  // Spec said 8-byte; corrected to 16 to match render API requirement
  // (rowBytes ≥ bytesPerPixel × width). Intent preserved: pre-allocated, no per-frame alloc.
  private var minMaxBufferA: (Float, Float, Float, Float) = (0, 0, 0, 0)
  private var minMaxBufferB: (Float, Float, Float, Float) = (0, 0, 0, 0)

  // MARK: - Lazy

  private lazy var ciContext: CIContext = {
    let device = MTLCreateSystemDefaultDevice()!
    return CIContext(mtlDevice: device, options: [
      .useSoftwareRenderer: false,
      .workingColorSpace: NSNull(),
    ])
  }()

  private lazy var turboLUT: CIImage = {
    return makeTurboLUT()
  }()

  // MARK: - Lifecycle

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    setupLayout()
    _ = turboLUT  // force generation on main thread
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    startSession()
    startLegendTimer()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    legendTimer?.invalidate()
    legendTimer = nil
    arView.session.pause()
    arView.session.delegate = nil
  }

  // MARK: - Setup

  private func setupLayout() {
    arView.translatesAutoresizingMaskIntoConstraints = false
    arView.automaticallyUpdatesLighting = true
    view.addSubview(arView)
    NSLayoutConstraint.activate([
      arView.topAnchor.constraint(equalTo: view.topAnchor),
      arView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      arView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      arView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])

    depthImageView.translatesAutoresizingMaskIntoConstraints = false
    depthImageView.contentMode = .scaleAspectFill
    depthImageView.alpha = 0.5
    depthImageView.isUserInteractionEnabled = false
    depthImageView.clipsToBounds = true
    view.addSubview(depthImageView)
    NSLayoutConstraint.activate([
      depthImageView.topAnchor.constraint(equalTo: view.topAnchor),
      depthImageView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      depthImageView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      depthImageView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])

    let safe = view.safeAreaLayoutGuide

    closeButton.translatesAutoresizingMaskIntoConstraints = false
    closeButton.setTitle("✕", for: .normal)
    closeButton.titleLabel?.font = .systemFont(ofSize: 22, weight: .semibold)
    closeButton.setTitleColor(.white, for: .normal)
    closeButton.backgroundColor = UIColor.black.withAlphaComponent(0.55)
    closeButton.layer.cornerRadius = 22
    closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
    view.addSubview(closeButton)
    NSLayoutConstraint.activate([
      closeButton.topAnchor.constraint(equalTo: safe.topAnchor, constant: 16),
      closeButton.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
      closeButton.widthAnchor.constraint(equalToConstant: 44),
      closeButton.heightAnchor.constraint(equalToConstant: 44),
    ])

    captureButton.translatesAutoresizingMaskIntoConstraints = false
    captureButton.setTitle("Capture", for: .normal)
    captureButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
    captureButton.setTitleColor(Self.goldColor, for: .normal)
    captureButton.backgroundColor = UIColor.black.withAlphaComponent(0.55)
    captureButton.layer.borderWidth = 1
    captureButton.layer.borderColor = Self.goldColor.withAlphaComponent(0.4).cgColor
    captureButton.layer.cornerRadius = 12
    captureButton.contentEdgeInsets = UIEdgeInsets(top: 12, left: 24, bottom: 12, right: 24)
    captureButton.addTarget(self, action: #selector(toggleFreeze), for: .touchUpInside)
    view.addSubview(captureButton)
    NSLayoutConstraint.activate([
      captureButton.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -32),
      captureButton.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
    ])

    badgeLabel.translatesAutoresizingMaskIntoConstraints = false
    badgeLabel.text = "  LiDAR Demo — not used for analysis  "
    badgeLabel.textColor = .white
    badgeLabel.font = .systemFont(ofSize: 12, weight: .regular)
    badgeLabel.textAlignment = .center
    badgeLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
    badgeLabel.layer.cornerRadius = 6
    badgeLabel.layer.masksToBounds = true
    view.addSubview(badgeLabel)
    NSLayoutConstraint.activate([
      badgeLabel.bottomAnchor.constraint(equalTo: captureButton.topAnchor, constant: -12),
      badgeLabel.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
      badgeLabel.heightAnchor.constraint(equalToConstant: 24),
    ])

    nearLabel.text  = "Near:   --"
    farLabel.text   = "Far:    --"
    rangeLabel.text = "Range:  --"
    for label in [nearLabel, farLabel, rangeLabel] {
      label.font = UIFont.monospacedSystemFont(ofSize: 13, weight: .medium)
      label.textAlignment = .right
    }
    nearLabel.textColor = UIColor(red: 0xc4/255.0, green: 0x25/255.0, blue: 0x03/255.0, alpha: 1.0)
    farLabel.textColor  = UIColor(red: 0x30/255.0, green: 0x12/255.0, blue: 0x3b/255.0, alpha: 1.0)
    rangeLabel.textColor = .white

    legendStack.translatesAutoresizingMaskIntoConstraints = false
    legendStack.axis = .vertical
    legendStack.alignment = .trailing
    legendStack.spacing = 2
    legendStack.backgroundColor = UIColor.black.withAlphaComponent(0.55)
    legendStack.layer.cornerRadius = 8
    legendStack.layer.masksToBounds = true
    legendStack.isLayoutMarginsRelativeArrangement = true
    legendStack.layoutMargins = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
    legendStack.addArrangedSubview(nearLabel)
    legendStack.addArrangedSubview(farLabel)
    legendStack.addArrangedSubview(rangeLabel)
    view.addSubview(legendStack)
    NSLayoutConstraint.activate([
      legendStack.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -16),
      legendStack.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -16),
    ])
  }

  private func startSession() {
    let config = ARWorldTrackingConfiguration()
    if ARWorldTrackingConfiguration.supportsFrameSemantics([.smoothedSceneDepth]) {
      config.frameSemantics = [.smoothedSceneDepth]
    } else {
      config.frameSemantics = [.sceneDepth]
    }
    arView.session.delegate = self
    arView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
  }

  private func startLegendTimer() {
    let interval = 1.0 / Self.legendRefreshHz
    legendTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
      self?.updateLegend()
    }
  }

  // MARK: - Actions

  @objc private func closeTapped() {
    dismiss(animated: true)
  }

  @objc private func toggleFreeze() {
    isFrozen.toggle()
    captureButton.setTitle(isFrozen ? "Resume" : "Capture", for: .normal)
    if !isFrozen {
      prevMinMaxSeeded = false
    }
  }

  // MARK: - Legend (§8)

  private func updateLegend() {
    guard !isFrozen else { return }
    if prevMinMaxSeeded && smoothedMin.isFinite && smoothedMax.isFinite {
      nearLabel.text  = String(format: "Near:   %.1f cm", smoothedMin * 100)
      farLabel.text   = String(format: "Far:    %.1f cm", smoothedMax * 100)
      rangeLabel.text = String(format: "Range:  %.1f mm", (smoothedMax - smoothedMin) * 1000)
    } else {
      nearLabel.text  = "Near:   --"
      farLabel.text   = "Far:    --"
      rangeLabel.text = "Range:  --"
    }
  }

  // MARK: - Turbo LUT (9-stop gradient)

  private func makeTurboLUT() -> CIImage {
    let size = CGSize(width: Self.lutWidth, height: 1)
    let renderer = UIGraphicsImageRenderer(size: size)
    let image = renderer.image { ctx in
      let cgctx = ctx.cgContext
      let stops: [CGFloat] = [0.00, 0.13, 0.25, 0.38, 0.50, 0.63, 0.75, 0.88, 1.00]
      let colors: [CGFloat] = [
        0x30/255.0, 0x12/255.0, 0x3b/255.0, 1.0,
        0x41/255.0, 0x45/255.0, 0xab/255.0, 1.0,
        0x46/255.0, 0x75/255.0, 0xed/255.0, 1.0,
        0x39/255.0, 0xa2/255.0, 0xfc/255.0, 1.0,
        0x1b/255.0, 0xcf/255.0, 0xd4/255.0, 1.0,
        0x3d/255.0, 0xef/255.0, 0x71/255.0, 1.0,
        0xb5/255.0, 0xfa/255.0, 0x4f/255.0, 1.0,
        0xff/255.0, 0x9b/255.0, 0x35/255.0, 1.0,
        0xc4/255.0, 0x25/255.0, 0x03/255.0, 1.0,
      ]
      let gradient = CGGradient(
        colorSpace: CGColorSpaceCreateDeviceRGB(),
        colorComponents: colors,
        locations: stops,
        count: stops.count
      )!
      cgctx.drawLinearGradient(
        gradient,
        start: CGPoint(x: 0, y: 0),
        end: CGPoint(x: size.width, y: 0),
        options: []
      )
    }
    return CIImage(image: image)!
  }
}

// MARK: - ARSessionDelegate

extension HoneyLiDARDemoViewController: ARSessionDelegate {

  func session(_ session: ARSession, didFailWithError error: Error) {
    print("[LiDAR Demo] AR session failed: \(error.localizedDescription)")
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      let alert = UIAlertController(
        title: "AR Session failed",
        message: error.localizedDescription,
        preferredStyle: .alert
      )
      alert.addAction(UIAlertAction(title: "Close", style: .default) { _ in
        self.dismiss(animated: true)
      })
      self.present(alert, animated: true)
    }
  }

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    // §1 READ SMOOTHED DEPTH + CONFIDENCE
    guard !isFrozen else { return }
    let depth = frame.smoothedSceneDepth ?? frame.sceneDepth
    guard let sceneDepth = depth else { return }
    let depthMap = sceneDepth.depthMap
    guard let confMap = sceneDepth.confidenceMap else { return }

    // Wrap CV pixel buffers as CIImages; rotate to portrait (.right = 90° CW)
    let depthCI = CIImage(cvPixelBuffer: depthMap).oriented(.right)
    let confCI  = CIImage(cvPixelBuffer: confMap).oriented(.right)
    let extent = depthCI.extent

    // §2 BUILD VALID-PIXEL MASK
    // Window mask: 1 where depthMin ≤ d ≤ depthMax
    let aboveMin = depthCI.applyingFilter("CIColorThreshold", parameters: [
      "inputThreshold": Self.depthWindowMin
    ])
    let aboveMaxRaw = depthCI.applyingFilter("CIColorThreshold", parameters: [
      "inputThreshold": Self.depthWindowMax
    ])
    let belowMax = aboveMaxRaw.applyingFilter("CIColorInvert")
    let windowMask = aboveMin.applyingFilter("CIMultiplyCompositing", parameters: [
      kCIInputBackgroundImageKey: belowMax
    ])

    // Confidence mask: UInt8 0/1/2 → normalized [0,1]. Threshold at minLevel/255.
    let confThreshold = Float(Self.minHighConfidenceLevel) / 255.0
    let confMask = confCI.applyingFilter("CIColorThreshold", parameters: [
      "inputThreshold": confThreshold
    ])

    let validMask = windowMask.applyingFilter("CIMultiplyCompositing", parameters: [
      kCIInputBackgroundImageKey: confMask
    ])

    // §3 AUTO-RANGE NORMALIZATION (two-pass: separate fills for min and max calcs)
    let bgForMin = CIImage(color: CIColor(red: CGFloat(Self.depthWindowMax),
                                           green: CGFloat(Self.depthWindowMax),
                                           blue: CGFloat(Self.depthWindowMax)))
      .cropped(to: extent)
    let bgForMax = CIImage(color: CIColor(red: CGFloat(Self.depthWindowMin),
                                           green: CGFloat(Self.depthWindowMin),
                                           blue: CGFloat(Self.depthWindowMin)))
      .cropped(to: extent)

    let depthForMin = depthCI.applyingFilter("CIBlendWithMask", parameters: [
      kCIInputBackgroundImageKey: bgForMin,
      kCIInputMaskImageKey: validMask,
    ])
    let depthForMax = depthCI.applyingFilter("CIBlendWithMask", parameters: [
      kCIInputBackgroundImageKey: bgForMax,
      kCIInputMaskImageKey: validMask,
    ])

    let minImage = depthForMin.applyingFilter("CIAreaMinMaxRed", parameters: [
      kCIInputExtentKey: CIVector(cgRect: extent)
    ])
    let maxImage = depthForMax.applyingFilter("CIAreaMinMaxRed", parameters: [
      kCIInputExtentKey: CIVector(cgRect: extent)
    ])

    ciContext.render(
      minImage,
      toBitmap: &minMaxBufferA,
      rowBytes: 16,
      bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
      format: .RGBAf,
      colorSpace: nil
    )
    ciContext.render(
      maxImage,
      toBitmap: &minMaxBufferB,
      rowBytes: 16,
      bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
      format: .RGBAf,
      colorSpace: nil
    )

    let currentMin = minMaxBufferA.0  // R channel = min
    let currentMax = minMaxBufferB.1  // G channel = max

    // NaN guard — zero-valid-pixels case
    guard currentMin.isFinite && currentMax.isFinite else { return }

    // Temporal smoothing (α = 0.15)
    let alpha = Self.temporalSmoothingAlpha
    if !prevMinMaxSeeded {
      smoothedMin = currentMin
      smoothedMax = currentMax
      prevMinMaxSeeded = true
    } else {
      smoothedMin = (1 - alpha) * smoothedMin + alpha * currentMin
      smoothedMax = (1 - alpha) * smoothedMax + alpha * currentMax
    }

    let span = max(smoothedMax - smoothedMin, 1e-4)
    let scale = 1.0 / span
    let offset = -smoothedMin / span

    let normalized = depthCI.applyingFilter("CIColorMatrix", parameters: [
      "inputRVector": CIVector(x: CGFloat(scale), y: 0, z: 0, w: 0),
      "inputGVector": CIVector(x: CGFloat(scale), y: 0, z: 0, w: 0),
      "inputBVector": CIVector(x: CGFloat(scale), y: 0, z: 0, w: 0),
      "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
      "inputBiasVector": CIVector(x: CGFloat(offset), y: CGFloat(offset), z: CGFloat(offset), w: 0),
    ])
    let clamped = normalized.applyingFilter("CIColorClamp", parameters: [
      "inputMinComponents": CIVector(x: 0, y: 0, z: 0, w: 0),
      "inputMaxComponents": CIVector(x: 1, y: 1, z: 1, w: 1),
    ])

    // §4 LANCZOS UPSAMPLE — BEFORE color LUT
    let upDepth = clamped.applyingFilter("CILanczosScaleTransform", parameters: [
      kCIInputScaleKey: Self.upsampleScale,
      kCIInputAspectRatioKey: 1.0,
    ])

    // §5 APPLY FALSE-COLOR LUT (Turbo 9-stop)
    let colored = upDepth.applyingFilter("CIColorMap", parameters: [
      "inputGradientImage": turboLUT,
    ])

    // §6 COMPOSITE WITH OUT-OF-WINDOW GRAY
    let upMask = validMask.applyingFilter("CILanczosScaleTransform", parameters: [
      kCIInputScaleKey: Self.upsampleScale,
      kCIInputAspectRatioKey: 1.0,
    ])
    let grayBg = CIImage(color: CIColor(red: Self.outOfWindowGray,
                                         green: Self.outOfWindowGray,
                                         blue: Self.outOfWindowGray))
      .cropped(to: colored.extent)
    let final = colored.applyingFilter("CIBlendWithMask", parameters: [
      kCIInputBackgroundImageKey: grayBg,
      kCIInputMaskImageKey: upMask,
    ])

    // §7 RENDER + DISPLAY
    guard let cgImage = ciContext.createCGImage(final, from: final.extent) else { return }
    let uiImage = UIImage(cgImage: cgImage)
    DispatchQueue.main.async { [weak self] in
      self?.depthImageView.image = uiImage
    }
  }
}
