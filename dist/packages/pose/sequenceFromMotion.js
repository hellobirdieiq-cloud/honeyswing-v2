"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPoseSequence = buildPoseSequence;
function buildPoseSequence(frames) {
    return {
        frames,
        source: "recording",
        metadata: {
            fps: 30,
            durationMs: frames.length > 0 ? frames[frames.length - 1].timestampMs : 0,
        },
    };
}
