/**
 * LabelScrubber — FIX 6c: the label-overlay scrubber. Thin phase-colored
 * track (44pt hit region) sitting above the overlay's chip row; tap =
 * absolute paused seek, drag = whole-frame RELATIVE precision scrubbing with
 * vertical sensitivity bands (band math + zero-jump re-anchor in
 * scrubberBands.ts). Every seek stays paused — the host's scrub trio
 * (begin/update/end from useSwingVideoClock) owns seek coalescing and the
 * definitive finger-up seek.
 *
 * Segments are colored by phase boundaries (pre-TA gray, TA→TOP, TOP→IMP,
 * IMP→FIN, post-FIN) from the phases prop — the host passes detected phases
 * LIVE-merged with the current unsaved stamps (3b), so a stamp moves its
 * boundary immediately and a reset reverts it. Boundary TICK MARKS
 * double-code the regions (never color alone): operator-stamped boundaries
 * render SOLID/bright, auto-only boundaries dimmer (`operator` flag per
 * entry). A white playhead line + thumb dot track videoIdx (the thumb is a
 * drag AFFORDANCE, not a handle — the full track remains the gesture
 * surface).
 *
 * GESTURE OWNERSHIP: Pan with minDistance(0) activates at touch-down, so
 * once a finger lands on the track no other recognizer (video-tap collapse
 * catcher, chips, the screen ScrollView) can take the gesture until lift.
 * OS-cancel keeps the last DISPLAYED frame — never reverts to the
 * touch-down frame — hides the bubble, and settles with the same definitive
 * end seek as finger-up. A tap is only honored on a real lift (onTouchesUp),
 * so a cancelled no-move touch cannot jump the playhead.
 */
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import {
  type ScrubBand,
  resolveBand,
  targetFrame,
  frameAtFraction,
  clampFrame,
} from './scrubberBands';
import { lightImpact } from './hapticTick';

/** Movement beyond this (pt, any direction) turns the touch into a drag. */
const TAP_SLOP_PT = 6;
const TRACK_HEIGHT = 5; // visible track (spec: 4–6pt)
const HIT_HEIGHT = 44; // interactive region (spec: ≥44pt)
const TICK_HEIGHT = 12;
const PLAYHEAD_HEIGHT = 16;
/** Playhead thumb — a VISUAL position indicator only, never an exclusive
 *  drag handle: the whole track stays the gesture surface (tap = absolute,
 *  drag = relative bands). Small enough to fit inside the 44pt hit region. */
const THUMB_SIZE = 12;
const BUBBLE_GAP = 6; // bubble bottom edge above the hit region

// Muted phase-segment palette (regions double-coded via boundary ticks).
const SEGMENT_COLORS = [
  '#48484A', // pre-takeaway gray
  '#46617A', // TA → TOP slate blue
  '#6A5A2E', // TOP → IMP olive
  '#6E4658', // IMP → FIN plum
  '#2C2C2E', // post-FIN dark gray
] as const;
// Operator-stamped boundary = solid/bright; auto-only = dimmer (3b).
const TICK_COLOR_OPERATOR = 'rgba(235,235,245,0.95)';
const TICK_COLOR_AUTO = 'rgba(235,235,245,0.35)';

type PhaseLike = { phase: string; index: number; operator?: boolean };

export function LabelScrubber({
  frameCount,
  videoIdx,
  phases,
  scrubBegin,
  scrubUpdate,
  scrubEnd,
}: {
  frameCount: number;
  videoIdx: number;
  phases: PhaseLike[] | null;
  scrubBegin: () => void;
  scrubUpdate: (frame: number) => void;
  scrubEnd: (frame: number) => void;
}) {
  const [trackW, setTrackW] = useState(0);
  const [bubble, setBubble] = useState<{ x: number; frame: number } | null>(null);
  const [bubbleW, setBubbleW] = useState(76);

  // All gesture-mutable state lives in a ref: the Gesture object is rebuilt
  // per render and its callbacks must see the live values mid-drag.
  const drag = useRef({
    anchorFrame: 0,
    anchorX: 0,
    band: 0 as ScrubBand,
    startX: 0,
    startY: 0,
    moved: false,
    lifted: false,
    target: 0,
  });
  const videoIdxRef = useRef(videoIdx);
  videoIdxRef.current = videoIdx;

  const onDown = (x: number, y: number) => {
    const d = drag.current;
    d.anchorFrame = clampFrame(videoIdxRef.current, frameCount);
    d.anchorX = x;
    d.band = 0;
    d.startX = x;
    d.startY = y;
    d.moved = false;
    d.lifted = false;
    d.target = d.anchorFrame;
    scrubBegin();
    setBubble({ x, frame: d.anchorFrame });
  };

  const onMove = (x: number, y: number) => {
    const d = drag.current;
    if (!d.moved && Math.hypot(x - d.startX, y - d.startY) > TAP_SLOP_PT) {
      d.moved = true;
    }
    const upPt = Math.max(0, d.startY - y);
    const band = resolveBand(d.band, upPt);
    if (band !== d.band) {
      // Continuity: re-anchor at the displayed frame + current finger X so
      // entering/leaving a band produces ZERO frame jump. One light tick per
      // actual crossing — hysteresis in resolveBand kills chatter, and this
      // branch is the only haptic call site.
      d.anchorFrame = d.target;
      d.anchorX = x;
      d.band = band;
      lightImpact();
    }
    const next = targetFrame(d.anchorFrame, d.anchorX, x, d.band, frameCount);
    if (next !== d.target) {
      d.target = next;
      scrubUpdate(next);
    }
    setBubble({ x, frame: next });
  };

  const onFinish = () => {
    const d = drag.current;
    // Tap (no drag, real lift): absolute seek to the tapped track position.
    // Drag or OS-cancel: settle on the last DISPLAYED frame — never revert.
    const frame =
      !d.moved && d.lifted && trackW > 0
        ? frameAtFraction(d.startX / trackW, frameCount)
        : d.target;
    setBubble(null);
    scrubEnd(frame);
  };

  const pan = Gesture.Pan()
    .minDistance(0)
    .maxPointers(1)
    .shouldCancelWhenOutside(false)
    .runOnJS(true)
    .onTouchesUp(() => {
      drag.current.lifted = true;
    })
    .onBegin((e) => onDown(e.x, e.y))
    .onUpdate((e) => onMove(e.x, e.y))
    .onFinalize(() => onFinish());

  // Phase boundaries as track fractions. All four must exist (they do for
  // any detected or operator-merged phase set); otherwise the track renders
  // as a single neutral segment. Edges are monotonized defensively so an
  // out-of-order operator stamp can't produce a negative-width segment.
  const edges = useMemo(() => {
    if (frameCount < 2) return null;
    const find = (name: string) => phases?.find((p) => p.phase === name);
    const ta = find('takeaway');
    const top = find('top');
    const imp = find('impact');
    const fin = find('follow_through');
    if (ta == null || top == null || imp == null || fin == null) return null;
    const bounds = [ta, top, imp, fin];
    const fracs = [0, ...bounds.map((b) => b.index), frameCount - 1].map(
      (i) => clampFrame(i, frameCount) / (frameCount - 1),
    );
    fracs[0] = 0;
    fracs[fracs.length - 1] = 1;
    for (let i = 1; i < fracs.length; i++) fracs[i] = Math.max(fracs[i], fracs[i - 1]);
    // Per-boundary operator flags, index-aligned with fracs.slice(1, -1).
    return { fracs, operator: bounds.map((b) => b.operator === true) };
  }, [phases, frameCount]);

  const playheadFrac =
    frameCount > 1 ? clampFrame(videoIdx, frameCount) / (frameCount - 1) : 0;
  const bubbleLeft = bubble
    ? Math.min(Math.max(0, bubble.x - bubbleW / 2), Math.max(0, trackW - bubbleW))
    : 0;

  return (
    <GestureHandlerRootView>
      <GestureDetector gesture={pan}>
        <View
          style={styles.hitArea}
          onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
        >
          <View style={styles.track}>
            {edges ? (
              SEGMENT_COLORS.map((color, i) => (
                <View
                  key={color}
                  style={{
                    width: `${(edges.fracs[i + 1] - edges.fracs[i]) * 100}%`,
                    backgroundColor: color,
                  }}
                />
              ))
            ) : (
              <View style={[styles.segmentFill, { backgroundColor: SEGMENT_COLORS[0] }]} />
            )}
          </View>
          {edges &&
            edges.fracs.slice(1, -1).map((frac, i) => (
              <View
                key={i}
                style={[
                  styles.tick,
                  {
                    left: `${frac * 100}%`,
                    backgroundColor: edges.operator[i]
                      ? TICK_COLOR_OPERATOR
                      : TICK_COLOR_AUTO,
                  },
                ]}
              />
            ))}
          <View style={[styles.playhead, { left: `${playheadFrac * 100}%` }]} />
          <View
            pointerEvents="none"
            style={[styles.thumb, { left: `${playheadFrac * 100}%` }]}
          />
        </View>
      </GestureDetector>
      {bubble != null && (
        <View
          pointerEvents="none"
          style={[styles.bubble, { left: bubbleLeft }]}
          onLayout={(e) => setBubbleW(e.nativeEvent.layout.width)}
        >
          <Text style={styles.bubbleText}>
            {bubble.frame} / {frameCount}
          </Text>
        </View>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  hitArea: {
    height: HIT_HEIGHT,
    justifyContent: 'center',
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  segmentFill: {
    flex: 1,
  },
  tick: {
    position: 'absolute',
    top: (HIT_HEIGHT - TICK_HEIGHT) / 2,
    width: 2,
    marginLeft: -1,
    height: TICK_HEIGHT,
    borderRadius: 1,
    // backgroundColor set inline per boundary (operator vs auto, 3b).
  },
  playhead: {
    position: 'absolute',
    top: (HIT_HEIGHT - PLAYHEAD_HEIGHT) / 2,
    width: 2,
    marginLeft: -1,
    height: PLAYHEAD_HEIGHT,
    borderRadius: 1,
    backgroundColor: '#FFF',
    // Dark halo keeps the white line visible over bright video content.
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 1,
    shadowOffset: { width: 0, height: 0 },
  },
  thumb: {
    position: 'absolute',
    top: (HIT_HEIGHT - THUMB_SIZE) / 2,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    marginLeft: -THUMB_SIZE / 2,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: '#FFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.4)',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  bubble: {
    position: 'absolute',
    bottom: HIT_HEIGHT + BUBBLE_GAP,
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderWidth: 1,
    borderColor: '#555',
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  bubbleText: {
    color: '#FFF',
    fontSize: 13,
    fontFamily: 'Menlo',
    fontWeight: '700',
  },
});
