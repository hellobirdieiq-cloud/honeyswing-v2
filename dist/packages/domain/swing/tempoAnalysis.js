"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEMPO_COLORS = exports.TEMPO_LABELS = void 0;
exports.calculateTempo = calculateTempo;
exports.serializePhaseTimestamps = serializePhaseTimestamps;
const TEMPO_THRESHOLDS = [
    { max: 1.5, rating: "rushed" },
    { max: 2.5, rating: "fast" },
    { max: 3.5, rating: "good" },
    { max: 4.5, rating: "slow" },
    { max: Infinity, rating: "very_slow" },
];
exports.TEMPO_LABELS = {
    rushed: "Rushed",
    fast: "Fast",
    good: "Good Tempo",
    slow: "Slow",
    very_slow: "Very Slow",
};
exports.TEMPO_COLORS = {
    rushed: "#FF4444",
    fast: "#FFB020",
    good: "#44CC44",
    slow: "#FFB020",
    very_slow: "#FF4444",
};
function rateTempo(ratio) {
    for (const threshold of TEMPO_THRESHOLDS) {
        if (ratio <= threshold.max)
            return threshold.rating;
    }
    return "very_slow";
}
function calculateTempo(phases) {
    if (phases.length < 6) {
        return null;
    }
    const addressPhase = phases.find((p) => p.phase === "address");
    const takeawayPhase = phases.find((p) => p.phase === "takeaway");
    const topPhase = phases.find((p) => p.phase === "top");
    const downswingPhase = phases.find((p) => p.phase === "downswing");
    const impactPhase = phases.find((p) => p.phase === "impact");
    const finishPhase = phases.find((p) => p.phase === "follow_through");
    if (!addressPhase || !takeawayPhase || !topPhase || !downswingPhase || !impactPhase || !finishPhase) {
        return null;
    }
    const backswingMs = topPhase.timestamp - addressPhase.timestamp;
    const downswingMs = impactPhase.timestamp - topPhase.timestamp;
    const totalSwingMs = finishPhase.timestamp - addressPhase.timestamp;
    if (downswingMs <= 0 || backswingMs <= 0) {
        return null;
    }
    const tempoRatio = Math.round((backswingMs / downswingMs) * 100) / 100;
    const tempoRating = rateTempo(tempoRatio);
    const phaseTimestamps = {
        address: addressPhase.timestamp,
        takeaway: takeawayPhase.timestamp,
        top: topPhase.timestamp,
        downswing: downswingPhase.timestamp,
        impact: impactPhase.timestamp,
        finish: finishPhase.timestamp,
    };
    return {
        backswingMs,
        downswingMs,
        tempoRatio,
        totalSwingMs,
        tempoRating,
        phaseTimestamps,
    };
}
function serializePhaseTimestamps(timestamps) {
    return {
        address: Math.round(timestamps.address),
        takeaway: Math.round(timestamps.takeaway),
        top: Math.round(timestamps.top),
        downswing: Math.round(timestamps.downswing),
        impact: Math.round(timestamps.impact),
        finish: Math.round(timestamps.finish),
    };
}
