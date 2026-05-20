const { withXcodeProject, IOSConfig } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const SOURCE_FILES = [
  "HoneyLiDARDemoModule.m",
  "HoneyLiDARDemoModule.swift",
  "HoneyLiDARDemoViewController.swift",
  "HoneyVisionCameraHandPlugin.m",
  "HoneyVisionCameraHandPlugin.swift",
  "HoneyVisionCameraPosePlugin.m",
  "HoneyVisionCameraPosePlugin.swift",
];

const RESOURCE_FILES = ["hand_landmarker.task", "pose_landmarker_full.task"];

// Explicit link required — Swift auto-linking for Vision proved unreliable
// in this build config; was repeatedly lost on prebuild --clean before this
// plugin existed. ARKit is needed by HoneyLiDARDemoViewController.
const FRAMEWORKS = ["Vision.framework", "ARKit.framework"];

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
          '"$(PODS_XCFRAMEWORKS_BUILD_DIR)/MediaPipeTasksVision"',
        ],
        build,
        projectName
      );
    }

    return config;
  });
};

module.exports = withHoneyNative;
