const { withXcodeProject, withDangerousMod, IOSConfig } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const MEDIAPIPE_LINK_FIX_MARKER = "# withHoneyNative: MediaPipeTasks link fix";

// Injected verbatim into ios/Podfile inside `post_install do |installer|`.
// Rewrites the Pods-honeyswing xcconfigs so vendored xcframeworks that
// CocoaPods emits as `-l"X"` are linked as `-framework "X"` instead —
// otherwise ld fails with "library 'MediaPipeTasksCommon' not found".
const MEDIAPIPE_LINK_FIX_BLOCK = `
    ${MEDIAPIPE_LINK_FIX_MARKER}
    ['Pods-honeyswing.debug.xcconfig', 'Pods-honeyswing.release.xcconfig'].each do |xcconfig_name|
      xcconfig_path = File.join(__dir__, 'Pods', 'Target Support Files', 'Pods-honeyswing', xcconfig_name)
      next unless File.exist?(xcconfig_path)
      xcconfig_contents = File.read(xcconfig_path)
      %w[MediaPipeTasksCommon MediaPipeTasksVision].each do |lib|
        xcconfig_contents = xcconfig_contents.gsub(%Q(-l"#{lib}"), %Q(-framework "#{lib}"))
      end
      File.write(xcconfig_path, xcconfig_contents)
    end
`;

const SOURCE_FILES = [
  "HoneyLiDARDemoModule.m",
  "HoneyLiDARDemoModule.swift",
  "HoneyLiDARDemoViewController.swift",
  "HoneyVisionCameraHandPlugin.m",
  "HoneyVisionCameraHandPlugin.swift",
  "HoneyVisionCameraPosePlugin.m",
  "HoneyVisionCameraPosePlugin.swift",
  "HoneyVisionAppleHandPlugin.m",
  "HoneyVisionAppleHandPlugin.swift",
  "HoneyMediaPipeOneShotPlugin.m",
  "HoneyMediaPipeOneShotPlugin.swift",
  "HoneyHandSegmenterPlugin.m",
  "HoneyHandSegmenterPlugin.swift",
  "HoneyRTMWModule.m",
  "HoneyRTMWModule.swift",
  "HoneyRtmwOneShotPlugin.m",
  "HoneyRtmwOneShotPlugin.swift",
  "HoneyAppleVisionBodyConfirmPlugin.m",
  "HoneyAppleVisionBodyConfirmPlugin.swift",
  "HoneyWatchImuModule.m",
  "HoneyWatchImuModule.swift",
];

const RESOURCE_FILES = ["hand_landmarker.task", "pose_landmarker_full.task", "selfie_segmenter.tflite"];

const RESOURCE_DIRS = ["rtmw_l_256x192.mlpackage"];

// Explicit link required — Swift auto-linking for Vision proved unreliable
// in this build config; was repeatedly lost on prebuild --clean before this
// plugin existed. ARKit is needed by HoneyLiDARDemoViewController.
// HealthKit linked on the host for HKHealthStore.startWatchApp (phone-driven watch launch).
const FRAMEWORKS = ["Vision.framework", "ARKit.framework", "CoreML.framework", "WatchConnectivity.framework", "HealthKit.framework"];

const withHoneyNative = (config) => {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const projectRoot = config.modRequest.projectRoot;
    const platformProjectRoot = config.modRequest.platformProjectRoot;
    const projectName = IOSConfig.XcodeUtils.getProjectName(projectRoot);
    const sourceDir = path.join(projectRoot, "native-assets", "ios");
    const destDir = path.join(platformProjectRoot, projectName);

    // Fail loud if canonical sources are missing — silent skip caused the bug
    // this refactor exists to fix.
    for (const fileName of [...SOURCE_FILES, ...RESOURCE_FILES]) {
      const src = path.join(sourceDir, fileName);
      if (!fs.existsSync(src)) {
        throw new Error(`[withHoneyNative] Missing canonical source: ${src}`);
      }
    }

    for (const dirName of RESOURCE_DIRS) {
      const src = path.join(sourceDir, dirName);
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
        throw new Error(`[withHoneyNative] Missing canonical source directory: ${src}`);
      }
    }

    fs.mkdirSync(destDir, { recursive: true });

    for (const fileName of SOURCE_FILES) {
      fs.copyFileSync(path.join(sourceDir, fileName), path.join(destDir, fileName));
      const relativePath = `${projectName}/${fileName}`;
      if (!project.hasFile(relativePath)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath: relativePath,
          groupName: projectName,
          project,
        });
      }
    }

    for (const fileName of RESOURCE_FILES) {
      fs.copyFileSync(path.join(sourceDir, fileName), path.join(destDir, fileName));
      const relativePath = `${projectName}/${fileName}`;
      if (!project.hasFile(relativePath)) {
        IOSConfig.XcodeUtils.addResourceFileToGroup({
          filepath: relativePath,
          groupName: projectName,
          isBuildFile: true,
          project,
        });
      }
    }

    for (const dirName of RESOURCE_DIRS) {
      fs.cpSync(path.join(sourceDir, dirName), path.join(destDir, dirName), { recursive: true });
      const relativePath = `${projectName}/${dirName}`;
      if (!project.hasFile(relativePath)) {
        IOSConfig.XcodeUtils.addResourceFileToGroup({
          filepath: relativePath,
          groupName: projectName,
          isBuildFile: true,
          project,
        });
      }
    }

    for (const framework of FRAMEWORKS) {
      IOSConfig.XcodeUtils.addFramework({ project, projectName, framework });
    }

    for (const build of ["Debug", "Release"]) {
      project.updateBuildProperty(
        "CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES",
        "YES",
        build,
        projectName
      );
    }

    for (const build of ["Debug", "Release"]) {
      project.updateBuildProperty(
        "FRAMEWORK_SEARCH_PATHS",
        [
          '"$(inherited)"',
          '"$(PODS_XCFRAMEWORKS_BUILD_DIR)/MediaPipeTasksCommon"',
          '"$(PODS_XCFRAMEWORKS_BUILD_DIR)/MediaPipeTasksVision"',
        ],
        build,
        projectName
      );
    }

    return config;
  });
};

const withMediaPipeLinkFix = (config) => {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, "Podfile");
      if (!fs.existsSync(podfilePath)) {
        throw new Error(`[withHoneyNative] Podfile not found at ${podfilePath}`);
      }
      let contents = fs.readFileSync(podfilePath, "utf8");
      if (contents.includes(MEDIAPIPE_LINK_FIX_MARKER)) {
        return config;
      }
      if (!contents.includes("react_native_post_install(")) {
        throw new Error(
          "[withHoneyNative] Expected `react_native_post_install(` call not found in ios/Podfile — cannot inject MediaPipeTasks link fix"
        );
      }
      // Anchor on the end of the react_native_post_install(...) call so the
      // xcconfig rewrite runs AFTER react_native_post_install regenerates the
      // Pods-honeyswing target-support xcconfigs. Anchoring earlier in
      // post_install gets clobbered by that regeneration.
      contents = contents.replace(
        /react_native_post_install\([\s\S]*?\n    \)/,
        (match) => `${match}${MEDIAPIPE_LINK_FIX_BLOCK}`
      );
      fs.writeFileSync(podfilePath, contents);
      return config;
    },
  ]);
};

module.exports = (config) => withMediaPipeLinkFix(withHoneyNative(config));
