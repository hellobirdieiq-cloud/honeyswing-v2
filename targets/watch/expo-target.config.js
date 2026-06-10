/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
// Phase 1: empty installable watchOS app target — shell only. No CoreMotion /
// WCSession / HealthKit query code yet. See docs/architecture/apple-watch-imu.md.
module.exports = (config) => ({
  type: "watch",
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
