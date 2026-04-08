const { withXcodeProject, IOSConfig } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const TASK_FILES = ["hand_landmarker.task", "pose_landmarker_full.task"];

const withTaskModels = (config) => {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const projectRoot = config.modRequest.projectRoot;
    const platformProjectRoot = config.modRequest.platformProjectRoot;
    const projectName = IOSConfig.Xcodeproj.getProjectName(projectRoot);

    for (const fileName of TASK_FILES) {
      const src = path.join(projectRoot, "ios", fileName);
      const destDir = path.join(platformProjectRoot, projectName);
      const dest = path.join(destDir, fileName);

      if (!fs.existsSync(src)) {
        console.warn(`[withTaskModels] ${src} not found, skipping`);
        continue;
      }

      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, dest);

      const relativePath = `${projectName}/${fileName}`;
      if (!project.hasFile(relativePath)) {
        IOSConfig.Xcodeproj.addResourceFileToGroup({
          filepath: relativePath,
          groupName: projectName,
          isBuildFile: true,
          project,
        });
      }
    }

    return config;
  });
};

module.exports = withTaskModels;
