import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, TextInput, StyleSheet } from 'react-native';
import type { LabelEvent, LabelSaveState } from './PhaseLabelBar';
import { LabelScrubber } from './LabelScrubber';

/**
 * VideoLabelOverlay + LabelControlsBelow — full-swing operator labeling,
 * edge-layout v2 (FIX 4b). The subject is center-frame, so on-video controls
 * hug the EDGES of the stage:
 *   - top strip: frame counter (< 214 / 350 >, tap → numeric input) centered,
 *     collapse control right-aligned;
 *   - left rail −5/−1 and right rail +1/+5, vertically centered, with
 *     press-and-hold repeat (FIX 6b);
 *   - phase-colored precision scrubber above the chip row (FIX 6c,
 *     LabelScrubber — the host's scrub trio owns coalescing/definitive seek);
 *   - bottom row: the phase chips in one line, fixed height (single-tap
 *     stamp — no layout jump; no idle hint text).
 * Everything else (delta summary, Reset, Save, save-error, save readout)
 * renders OFF the video via LabelControlsBelow.
 *
 * FIX 4c: the blue [Label ▴] tab on the video is the ONLY label-mode control —
 * the host expands via the tab and collapses via Label ▾ or a video-surface
 * tap (host-side tap-catcher; chips/rails/scrubber render as LATER siblings,
 * so they always win the touch — the catcher only sees bare video taps).
 *
 * FIX 6a: label mode = PAUSED — the host pauses on expand and hides the play
 * button while expanded; every seek issued from this overlay stays paused.
 *
 * Interaction contract: SINGLE-TAP stamp — tapping a chip stamps that phase
 * at the CURRENT frame immediately (latest-wins on re-tap), confirmed by a
 * FLASH_MS highlight + the ✓/fN title. NO seek happens in the stamp path;
 * the delta tokens below the video (LabelControlsBelow) are the ONLY route
 * to the app's detected guess (tap = paused seek). This DIVERGES from
 * PhaseLabelBar's two-tap arm — the putting screen keeps that panel
 * unchanged; reconcile in the P-103 extraction.
 */

const DELTA_WARN = 3;
const FLASH_MS = 600;
/** 3a confirm-reset escape (EXTERNAL-ASSUMPTION tunable): the armed
 *  "Confirm reset?" state auto-reverts to "Reset labels" after this long. */
const RESET_CONFIRM_MS = 3000;
/** FIX 6b hold-to-repeat (EXTERNAL-ASSUMPTION tunables): initial delay before
 *  the step repeats, then the repeat cadence. */
const STEP_HOLD_DELAY_MS = 350;
const STEP_HOLD_INTERVAL_MS = 80;
/** Height the absolute-positioned chip row occupies (chip 50 + 2×8 padding) —
 *  the scrubber sits above it. */
const CHIP_ROW_HEIGHT = 66;
/** Extra breathing room between the scrubber and the chip row — visually
 *  separates navigation (scrubber) from labeling (chips). */
const SCRUBBER_CHIP_GAP = 10;

export function VideoLabelOverlay({
  events,
  frameCount,
  videoIdx,
  seekToFrame,
  labels,
  onStamp,
  onCollapse,
  phases,
  scrubBegin,
  scrubUpdate,
  scrubEnd,
}: {
  events: LabelEvent[];
  frameCount: number;
  videoIdx: number;
  seekToFrame: (index: number, opts?: { autoPlay?: boolean }) => void;
  labels: Record<string, number | undefined>;
  onStamp: (key: string, frame: number) => void;
  onCollapse: () => void;
  /** FIX 6c scrubber inputs + 3b live boundaries: the host passes detected
   *  phases merged with the CURRENT unsaved stamps (a stamp moves its tick
   *  immediately; reset reverts). `operator` marks stamped boundaries —
   *  the scrubber renders them solid, auto-only ones dimmer. Plus the
   *  clock's coalesced scrub trio. */
  phases: { phase: string; index: number; operator?: boolean }[] | null;
  scrubBegin: () => void;
  scrubUpdate: (frame: number) => void;
  scrubEnd: (frame: number) => void;
}) {
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [frameInputOpen, setFrameInputOpen] = useState(false);
  const [frameInputText, setFrameInputText] = useState('');

  // Reset lives below the stage — kill a stale stamp flash when the host
  // wipes the label set out from under us.
  const stampedCount = events.filter((ev) => labels[ev.key] != null).length;
  useEffect(() => {
    if (stampedCount === 0) setFlashKey(null);
  }, [stampedCount]);

  const clampFrame = (f: number) => Math.min(Math.max(0, f), Math.max(0, frameCount - 1));

  // FIX 6b hold-to-repeat: press-in fires the first step immediately (single
  // tap = one step, unchanged), then after STEP_HOLD_DELAY_MS repeats every
  // STEP_HOLD_INTERVAL_MS until press-out/cancel. The running frame lives in
  // the ref (not the videoIdx prop) so the repeat cadence never races the
  // render round-trip; every seek is paused and clamped at clip bounds.
  const holdRef = useRef<{
    delay: ReturnType<typeof setTimeout> | null;
    interval: ReturnType<typeof setInterval> | null;
    frame: number;
  }>({ delay: null, interval: null, frame: 0 });
  const stopHold = () => {
    const h = holdRef.current;
    if (h.delay != null) clearTimeout(h.delay);
    if (h.interval != null) clearInterval(h.interval);
    h.delay = null;
    h.interval = null;
  };
  const startHold = (delta: number) => {
    stopHold();
    const h = holdRef.current;
    h.frame = clampFrame(videoIdx + delta);
    seekToFrame(h.frame, { autoPlay: false });
    h.delay = setTimeout(() => {
      h.delay = null;
      h.interval = setInterval(() => {
        const next = clampFrame(h.frame + delta);
        if (next === h.frame) return; // clamped at a clip bound — hold, don't re-seek
        h.frame = next;
        seekToFrame(next, { autoPlay: false });
      }, STEP_HOLD_INTERVAL_MS);
    }, STEP_HOLD_DELAY_MS);
  };
  useEffect(() => stopHold, []);

  const flash = (key: string) => {
    setFlashKey(key);
    setTimeout(() => setFlashKey((k) => (k === key ? null : k)), FLASH_MS);
  };

  // Single-tap stamp: every tap marks the phase at the CURRENT frame
  // (latest-wins on re-tap). NO seek in this path — the operator's playhead
  // never moves out from under them; the flash + ✓/fN title confirm.
  const onChipTap = (ev: LabelEvent) => {
    onStamp(ev.key, videoIdx);
    flash(ev.key);
  };

  const submitFrameInput = () => {
    const n = parseInt(frameInputText, 10);
    if (Number.isFinite(n)) seekToFrame(clampFrame(n), { autoPlay: false });
    setFrameInputOpen(false);
    setFrameInputText('');
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Top strip: frame counter centered, collapse right */}
      <View style={styles.topStrip}>
        <View style={styles.topStripSide} />
        {frameInputOpen ? (
          <TextInput
            style={[styles.frameBox, styles.frameInput]}
            value={frameInputText}
            onChangeText={setFrameInputText}
            keyboardType="number-pad"
            autoFocus
            onSubmitEditing={submitFrameInput}
            onBlur={submitFrameInput}
            placeholder={`f${videoIdx}`}
            placeholderTextColor="#666"
          />
        ) : (
          <Pressable
            style={styles.frameBox}
            onPress={() => {
              setFrameInputText(String(videoIdx));
              setFrameInputOpen(true);
            }}
          >
            {/* FIX 6d: < current / total > — arrows keep accent blue
                (interactivity cue), numbers solid white for contrast over
                bright footage. */}
            <Text style={styles.frameText}>
              {'<'}<Text style={styles.frameTextNum}> {videoIdx} / {frameCount} </Text>{'>'}
            </Text>
          </Pressable>
        )}
        <Pressable style={styles.topStripSide} onPress={onCollapse} hitSlop={8}>
          <Text style={styles.collapseText}>Label ▾</Text>
        </Pressable>
      </View>

      {/* Edge rails — press-and-hold repeats the step (FIX 6b). Fine step on
          top, coarse below; same row = same magnitude across the two rails. */}
      <View style={[styles.rail, styles.railLeft]} pointerEvents="box-none">
        <Pressable style={styles.railBtn} onPressIn={() => startHold(-1)} onPressOut={stopHold}>
          <Text style={styles.railText}>−1</Text>
        </Pressable>
        <Pressable style={styles.railBtn} onPressIn={() => startHold(-5)} onPressOut={stopHold}>
          <Text style={styles.railText}>−5</Text>
        </Pressable>
      </View>
      <View style={[styles.rail, styles.railRight]} pointerEvents="box-none">
        <Pressable style={styles.railBtn} onPressIn={() => startHold(1)} onPressOut={stopHold}>
          <Text style={styles.railText}>+1</Text>
        </Pressable>
        <Pressable style={styles.railBtn} onPressIn={() => startHold(5)} onPressOut={stopHold}>
          <Text style={styles.railText}>+5</Text>
        </Pressable>
      </View>

      {/* FIX 6c: precision scrubber — thin phase-colored track above the chip
          row; tap = absolute paused seek, drag = relative whole-frame
          precision (vertical bands). box-none wrapper: only the 44pt hit
          strip takes touches. */}
      <View style={styles.scrubberWrap} pointerEvents="box-none">
        <LabelScrubber
          frameCount={frameCount}
          videoIdx={videoIdx}
          phases={phases}
          scrubBegin={scrubBegin}
          scrubUpdate={scrubUpdate}
          scrubEnd={scrubEnd}
        />
      </View>

      {/* Bottom chip row — one line, fixed height. Tap = stamp at the
          current frame; the FLASH_MS highlight confirms the write. */}
      <View style={styles.chipRow}>
        {events.map((ev) => {
          const stamped = labels[ev.key];
          const flashing = flashKey === ev.key;
          return (
            <Pressable
              key={ev.key}
              style={[
                styles.chip,
                stamped != null && styles.chipStamped,
                flashing && styles.chipFlash,
              ]}
              onPress={() => onChipTap(ev)}
            >
              <Text style={[styles.chipTitle, stamped != null && styles.chipTitleStamped]}>
                {stamped != null ? `✓ ${ev.label} f${stamped}` : ev.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function LabelControlsBelow({
  events,
  labels,
  seekToFrame,
  onResetLabels,
  onSave,
  saveButtonLabel,
  saveState,
  saveDisabledReason,
  saveSummary,
  saveError,
}: {
  events: LabelEvent[];
  labels: Record<string, number | undefined>;
  seekToFrame: (index: number, opts?: { autoPlay?: boolean }) => void;
  onResetLabels: () => void;
  onSave?: () => void;
  saveButtonLabel: string;
  saveState: LabelSaveState;
  saveDisabledReason?: string;
  saveSummary?: string | null;
  saveError?: string | null;
}) {
  const [resetArmed, setResetArmed] = useState(false);
  const stampedCount = events.filter((ev) => labels[ev.key] != null).length;

  // 3a confirm-reset escape: the armed state auto-reverts after
  // RESET_CONFIRM_MS, and any touch inside this panel OTHER than the reset
  // button cancels it immediately. onTouchStart is passive (never claims the
  // responder), so the cancelling tap is NOT swallowed — delta tokens and
  // Save still receive it; the reset button stops propagation so its own
  // confirm tap can't disarm itself. Taps outside the panel (video stage)
  // fall back to the timer.
  useEffect(() => {
    if (!resetArmed) return;
    const t = setTimeout(() => setResetArmed(false), RESET_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [resetArmed]);
  const cancelResetConfirm = () => {
    if (resetArmed) setResetArmed(false);
  };

  return (
    <View style={styles.belowContainer} onTouchStart={cancelResetConfirm}>
      {/* Delta token line — tap seeks (paused) to the detected frame. Since
          the single-tap chip change, this is the ONLY route to the app's
          detected guess. */}
      <View style={styles.deltaLine}>
        {events.map((ev) => {
          const you = labels[ev.key];
          const auto = ev.detectedFrame;
          const delta = you != null && auto != null ? you - auto : null;
          const warn = delta != null && Math.abs(delta) > DELTA_WARN;
          return (
            <Pressable
              key={ev.key}
              onPress={() => {
                if (ev.detectedFrame == null) return;
                seekToFrame(ev.detectedFrame, { autoPlay: false });
              }}
            >
              <Text style={styles.deltaLabel}>
                {ev.label}{' '}
                <Text style={[styles.deltaValue, warn && styles.deltaWarn]}>
                  {delta != null
                    ? `Δ${delta > 0 ? '+' : ''}${delta}`
                    : you != null
                      ? `f${you}`
                      : '—'}
                </Text>
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Reset + Save */}
      <View style={styles.actionRow}>
        <Pressable
          style={[styles.resetBtn, resetArmed && styles.resetArmed]}
          onTouchStart={(e) => e.stopPropagation()}
          onPress={() => {
            if (resetArmed) {
              onResetLabels();
              setResetArmed(false);
            } else if (stampedCount > 0) {
              setResetArmed(true);
            }
          }}
        >
          <Text style={[styles.resetText, resetArmed && styles.resetTextArmed]}>
            {resetArmed ? 'Confirm reset?' : 'Reset labels'}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.saveBtn, saveState !== 'ready' && styles.saveBtnDisabled]}
          disabled={saveState !== 'ready'}
          onPress={onSave}
        >
          <Text style={styles.saveText}>
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'saved'
                ? '✓ Saved'
                : saveButtonLabel}
          </Text>
        </Pressable>
      </View>
      {saveState === 'disabled' && saveDisabledReason != null && (
        <Text style={styles.disabledReason}>{saveDisabledReason}</Text>
      )}
      {saveSummary != null && <Text style={styles.saveSummary}>{saveSummary}</Text>}
      {saveError != null && <Text style={styles.saveError}>{saveError}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  // ── on-video ──
  topStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)', // lighter than the other strips: more video shows through
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  topStripSide: {
    flex: 1,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  collapseText: {
    color: '#0A84FF',
    fontSize: 13,
    fontWeight: '700',
    paddingVertical: 4,
  },
  frameBox: {
    // Rail treatment, lighter (rails 0.6) — composites over the 0.45 strip so
    // the numbers get a dark patch on bright video without darkening the strip.
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1,
    borderColor: '#0A84FF',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frameText: {
    color: '#0A84FF',
    fontSize: 14,
    fontFamily: 'Menlo',
    fontWeight: '700',
  },
  frameTextNum: {
    color: '#FFF',
  },
  frameInput: {
    color: '#FFF',
    fontSize: 14,
    fontFamily: 'Menlo',
    minWidth: 84,
    paddingVertical: 4,
    textAlign: 'center',
  },
  rail: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    gap: 8,
  },
  railLeft: { left: 8 },
  railRight: { right: 8 },
  railBtn: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1,
    borderColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  railText: {
    color: '#FFF',
    fontSize: 14,
    fontFamily: 'Menlo',
    fontWeight: '700',
  },
  scrubberWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: CHIP_ROW_HEIGHT + SCRUBBER_CHIP_GAP,
    paddingHorizontal: 14,
  },
  chipRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 6,
    padding: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  chip: {
    flex: 1,
    height: 50, // fixed: matches the panel's two-line chip — no layout jump on stamp
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipStamped: {
    borderColor: '#30D158',
    backgroundColor: '#30D15818',
  },
  chipFlash: {
    backgroundColor: '#FFD60A33',
  },
  chipTitle: {
    color: '#FFF',
    fontSize: 13,
    fontFamily: 'Menlo',
    fontWeight: '700',
  },
  chipTitleStamped: {
    color: '#30D158',
  },
  // ── below-stage ──
  belowContainer: {
    backgroundColor: '#141416',
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
  },
  deltaLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    paddingVertical: 2,
  },
  // Δ value carries the visual weight; the phase label recedes.
  deltaLabel: {
    color: '#777',
    fontSize: 12,
    fontFamily: 'Menlo',
  },
  deltaValue: {
    color: '#E5E5EA',
    fontSize: 13,
    fontFamily: 'Menlo',
    fontWeight: '700',
  },
  deltaWarn: {
    color: '#FF9F0A',
    fontWeight: '700',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  resetBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#555',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  resetArmed: {
    borderColor: '#FF453A',
    backgroundColor: '#FF453A22',
  },
  resetText: {
    color: '#AAA',
    fontSize: 14,
    fontWeight: '600',
  },
  resetTextArmed: {
    color: '#FF6961',
  },
  saveBtn: {
    flex: 1.4,
    backgroundColor: '#0A84FF',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  saveBtnDisabled: {
    backgroundColor: '#333',
  },
  saveText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '700',
  },
  disabledReason: {
    color: '#888',
    fontSize: 12,
    marginTop: 6,
    textAlign: 'center',
  },
  saveSummary: {
    color: '#30D158',
    fontSize: 12,
    fontFamily: 'Menlo',
    textAlign: 'center',
    marginTop: 8,
  },
  saveError: {
    color: '#FF6961',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
  },
});
