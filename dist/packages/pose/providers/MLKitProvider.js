"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MLKitProvider = void 0;
const V1_TO_V2_JOINT_MAP = {
    nose: "nose",
    leftEye: "leftEye",
    rightEye: "rightEye",
    leftEar: "leftEar",
    rightEar: "rightEar",
    leftShoulder: "leftShoulder",
    rightShoulder: "rightShoulder",
    leftElbow: "leftElbow",
    rightElbow: "rightElbow",
    leftWrist: "leftWrist",
    rightWrist: "rightWrist",
    leftHip: "leftHip",
    rightHip: "rightHip",
    leftKnee: "leftKnee",
    rightKnee: "rightKnee",
    leftAnkle: "leftAnkle",
    rightAnkle: "rightAnkle",
    leftHeel: "leftHeel",
    rightHeel: "rightHeel",
    leftFootIndex: "leftFootIndex",
    rightFootIndex: "rightFootIndex",
};
function createEmptyJoints() {
    return {
        nose: undefined,
        leftEye: undefined,
        rightEye: undefined,
        leftEar: undefined,
        rightEar: undefined,
        leftShoulder: undefined,
        rightShoulder: undefined,
        leftElbow: undefined,
        rightElbow: undefined,
        leftWrist: undefined,
        rightWrist: undefined,
        leftHip: undefined,
        rightHip: undefined,
        leftKnee: undefined,
        rightKnee: undefined,
        leftAnkle: undefined,
        rightAnkle: undefined,
        leftHeel: undefined,
        rightHeel: undefined,
        leftFootIndex: undefined,
        rightFootIndex: undefined,
    };
}
function mapLandmarksToPoseFrame(params) {
    const { landmarks, timestampMs, frameWidth, frameHeight } = params;
    const joints = createEmptyJoints();
    for (const landmark of landmarks) {
        const jointName = V1_TO_V2_JOINT_MAP[landmark.name];
        if (!jointName)
            continue;
        if (landmark.isPresent === false)
            continue;
        joints[jointName] = {
            name: jointName,
            x: landmark.x,
            y: landmark.y,
            z: Number.isFinite(landmark.z) ? landmark.z : undefined,
            confidence: Number.isFinite(landmark.inFrameLikelihood)
                ? landmark.inFrameLikelihood
                : undefined,
        };
    }
    return {
        timestampMs,
        joints,
        frameWidth,
        frameHeight,
    };
}
class MLKitProvider {
    constructor() {
        this.name = "mlkit";
    }
    async detectFromVideo({ videoUri }) {
        void videoUri;
        throw new Error("MLKitProvider.detectFromVideo not implemented yet");
    }
    async detectFromFrame(params) {
        const { frame, timestampMs, frameWidth, frameHeight } = params;
        const landmarks = frame;
        return mapLandmarksToPoseFrame({
            landmarks,
            timestampMs,
            frameWidth,
            frameHeight,
        });
    }
}
exports.MLKitProvider = MLKitProvider;
