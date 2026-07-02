/**
 * Source-of-truth capture format for HoneySwing.
 * Locked in Phase G1 (240fps device-format inspection, iPhone 15 Pro,
 * react-native-vision-camera v4.7.3). Format 38: 1920x1080 @ maxFps 240,
 * the highest device format meeting fps>=240 AND resolution>=1920x1080.
 * No consumer yet — wired in a later phase.
 */
export const CAPTURE_WIDTH = 1920;
export const CAPTURE_HEIGHT = 1080;
export const CAPTURE_FPS = 240;
export const ANALYZER_DECIMATION = 2;
