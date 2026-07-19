import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, TextInput, StyleSheet } from 'react-native';
import type { LabelEvent, LabelSaveState } from './PhaseLabelBar';

/**
 * VideoLabelOverlay + LabelControlsBelow — full-swing operator labeling,
 * edge-layout v2 (FIX 4b). The subject is center-frame, so on-video controls
 * hug the EDGES of the stage:
 *   - top strip: frame counter (< f214 >, tap → numeric input) centered,
 *     collapse control right-aligned;
 *   - left rail −5/−1 and right rail +1/+5, vertically centered;
 *   - bottom row: the phase chips in one line, fixed height (armed hint
 *     renders inside it — no layout jump; no idle hint text).
 * Everything else (delta summary, Reset, Save, save-error, save readout)
 * renders OFF the video via LabelControlsBelow.
 *
 * FIX 4c: the blue [Label ▴] tab on the video is the ONLY label-mode control —
 * the host expands via the tab and collapses via Label ▾ or a video-surface
 * tap (host-side tap-catcher, guarded by onArmedChange so an armed two-tap
 * flow is never interrupted).
 *
 * Interaction contract is identical to PhaseLabelBar (two-tap arm, latest-wins
 * re-stamp, FLASH_MS flash on detected-seek, every seek PAUSED via
 * {autoPlay:false}); the host owns labels/persistence/recompute. The putting
 * screen keeps the original PhaseLabelBar panel.
 */

const DELTA_WARN = 3;
const FLASH_MS = 600;

export function VideoLabelOverlay({
  events,
  frameCount,
  videoIdx,
  seekToFrame,
  labels,
  onStamp,
  onCollapse,
  onArmedChange,
}: {
  events: LabelEvent[];
  frameCount: number;
  videoIdx: number;
  seekToFrame: (index: number, opts?: { autoPlay?: boolean }) => void;
  labels: Record<string, number | undefined>;
  onStamp: (key: string, frame: number) => void;
  onCollapse: () => void;
  /** Reports two-tap arm state to the host (FIX 4c: a video-surface tap
   *  collapses the overlay ONLY when no chip is armed). Pass a stable
   *  callback (useCallback) — it sits in an effect dep list. */
  onArmedChange?: (armed: boolean) => void;
}) {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [frameInputOpen, setFrameInputOpen] = useState(false);
  const [frameInputText, setFrameInputText] = useState('');

  // Reset now lives below the stage — clear a stale arm when the host wipes
  // the label set out from under us.
  const stampedCount = events.filter((ev) => labels[ev.key] != null).length;
  useEffect(() => {
    if (stampedCount === 0) {
      setArmedKey(null);
      onArmedChange?.(false);
    }
  }, [stampedCount, onArmedChange]);

  const setArmed = (key: string | null) => {
    setArmedKey(key);
    onArmedChange?.(key != null);
  };

  const clampFrame = (f: number) => Math.min(Math.max(0, f), Math.max(0, frameCount - 1));
  const step = (delta: number) => {
    seekToFrame(clampFrame(videoIdx + delta), { autoPlay: false });
  };

  const flash = (key: string) => {
    setFlashKey(key);
    setTimeout(() => setFlashKey((k) => (k === key ? null : k)), FLASH_MS);
  };

  const seekToDetected = (ev: LabelEvent) => {
    if (ev.detectedFrame == null) return;
    seekToFrame(clampFrame(ev.detectedFrame), { autoPlay: false });
    flash(ev.key);
  };

  const onChipTap = (ev: LabelEvent) => {
    const stamped = labels[ev.key] != null;
    if (stamped) {
      onStamp(ev.key, videoIdx); // re-stamp at playhead, latest wins
      setArmed(null);
      return;
    }
    if (armedKey === ev.key) {
      onStamp(ev.key, videoIdx); // tap 2: stamp current playhead frame
      setArmed(null);
    } else {
      setArmed(ev.key); // tap 1: arm + jump to the Auto frame
      seekToDetected(ev);
    }
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
            <Text style={styles.frameText}>{'<'} f{videoIdx} {'>'}</Text>
          </Pressable>
        )}
        <Pressable style={styles.topStripSide} onPress={onCollapse} hitSlop={8}>
          <Text style={styles.collapseText}>Label ▾</Text>
        </Pressable>
      </View>

      {/* Edge rails */}
      <View style={[styles.rail, styles.railLeft]} pointerEvents="box-none">
        <Pressable style={styles.railBtn} onPress={() => step(-5)}>
          <Text style={styles.railText}>−5</Text>
        </Pressable>
        <Pressable style={styles.railBtn} onPress={() => step(-1)}>
          <Text style={styles.railText}>−1</Text>
        </Pressable>
      </View>
      <View style={[styles.rail, styles.railRight]} pointerEvents="box-none">
        <Pressable style={styles.railBtn} onPress={() => step(1)}>
          <Text style={styles.railText}>+1</Text>
        </Pressable>
        <Pressable style={styles.railBtn} onPress={() => step(5)}>
          <Text style={styles.railText}>+5</Text>
        </Pressable>
      </View>

      {/* Bottom chip row — one line, fixed height (armed hint fits inside) */}
      <View style={styles.chipRow}>
        {events.map((ev) => {
          const stamped = labels[ev.key];
          const armed = armedKey === ev.key;
          const flashing = flashKey === ev.key;
          return (
            <Pressable
              key={ev.key}
              style={[
                styles.chip,
                stamped != null && styles.chipStamped,
                armed && styles.chipArmed,
                flashing && styles.chipFlash,
              ]}
              onPress={() => onChipTap(ev)}
            >
              <Text style={[styles.chipTitle, stamped != null && styles.chipTitleStamped]}>
                {stamped != null ? `✓ ${ev.label} f${stamped}` : ev.label}
              </Text>
              {armed && (
                <Text style={styles.chipHint}>{`tap again to mark f${videoIdx}`}</Text>
              )}
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

  return (
    <View style={styles.belowContainer}>
      {/* Delta token line — tap seeks (paused) to the detected frame */}
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
              <Text style={[styles.deltaText, warn && styles.deltaWarn]}>
                {ev.label}{' '}
                {delta != null
                  ? `Δ${delta > 0 ? '+' : ''}${delta}`
                  : you != null
                    ? `f${you}`
                    : '—'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Reset + Save */}
      <View style={styles.actionRow}>
        <Pressable
          style={[styles.resetBtn, resetArmed && styles.resetArmed]}
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
    backgroundColor: 'rgba(0,0,0,0.6)',
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
    height: 50, // fixed: matches the panel's two-line chip; armed hint fits inside
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
  chipArmed: {
    borderColor: '#FFD60A',
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
  chipHint: {
    color: '#FFD60A',
    fontSize: 10,
    marginTop: 2,
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
  deltaText: {
    color: '#AAA',
    fontSize: 13,
    fontFamily: 'Menlo',
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
