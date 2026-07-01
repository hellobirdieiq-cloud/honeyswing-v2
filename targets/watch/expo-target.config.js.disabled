/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
// Phase 2: watchOS app captures wrist IMU during a swing (HKWorkoutSession +
// CMBatchedSensorManager). No watch->phone transfer / JS / persistence yet.
// See docs/architecture/apple-watch-imu.md.
module.exports = (config) => ({
  type: "watch",
  // The "watch" target type auto-links zero frameworks (@bacons/apple-targets
  // TARGET_REGISTRY), so link the two the Phase-2 Swift code imports explicitly.
  frameworks: ["HealthKit", "CoreMotion"],
  // Xcode target name + home-screen display name (locked Phase-1 decision).
  name: "honeyswingWatch",
  displayName: "honeyswing Watch",
  // Dot-prefix → appended to the host bundle id, yielding
  // com.honeyswing.honeyswing-v2.watchkitapp. WITHOUT this, apple-targets
  // defaults to "<host>.watch" (sanitize(type)) — NOT the locked id.
  bundleIdentifier: ".watchkitapp",
  // watchOS minimum; pairs with the host iOS deploymentTarget (17.0).
  deploymentTarget: "10.0",
  // HealthKit entitlement provisioned now so the workout-session IMU unlock
  // (Phase 2+) needs no re-provisioning. No HealthKit *code* in Phase 1.
  entitlements: {
    "com.apple.developer.healthkit": true,
  },
});
