"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeSwing = analyzeSwing;
const PoseProviderRegistry_1 = require("../../pose/PoseProviderRegistry");
const angles_1 = require("./angles");
const phaseDetection_1 = require("./phaseDetection");
const tempoAnalysis_1 = require("./tempoAnalysis");
const scoring_1 = require("./scoring");
function buildTrailPoints(sequence) {
    const points = [];
    for (const frame of sequence.frames) {
        const lw = frame.joints.leftWrist;
        const rw = frame.joints.rightWrist;
        if (!lw || !rw)
            continue;
        points.push({
            x: (lw.x + rw.x) / 2,
            y: (lw.y + rw.y) / 2,
            timestamp: frame.timestampMs,
        });
    }
    return points;
}
async function analyzeSwing(videoUri) {
    const provider = (0, PoseProviderRegistry_1.getPoseProvider)();
    const sequence = await provider.detectFromVideo({
        videoUri,
    });
    if (!sequence.frames || sequence.frames.length === 0) {
        return {
            score: 0,
            honeyBoom: false,
        };
    }
    const midFrame = sequence.frames[Math.floor(sequence.frames.length / 2)];
    const angles = (0, angles_1.calculateGolfAngles)(midFrame);
    const trail = buildTrailPoints(sequence);
    const phases = (0, phaseDetection_1.detectSwingPhases)(trail);
    const tempo = (0, tempoAnalysis_1.calculateTempo)(phases);
    const scoring = (0, scoring_1.scoreSwing)({
        angles,
        tempo,
    });
    return {
        score: scoring.score,
        honeyBoom: scoring.honeyBoom,
        angles,
        tempo,
        phases,
    };
}
