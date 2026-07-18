import React, { useState } from 'react';
import { View, Text, Pressable, TextInput, StyleSheet } from 'react-native';

/**
 * PhaseLabelBar — operator frame-labeling bar, shared by the putting result
 * screen (authoritative corrections) and the full-swing result screen
 * (annotate-only). Pure UI: no supabase, no domain imports — the host screen
 * owns persistence, recompute, and label state.
 *
 * Interactions (owner-specified):
 *  - Stepper −5 · −1 · < f57 > · +1 · +5 — every seek is PAUSED
 *    (seekToFrame(..., {autoPlay:false})); the frame number is tappable →
 *    numeric input, clamped to range, paused seek on submit.
 *  - Stamp chips, TWO-TAP ARM: unstamped chip shows "tap to mark"; tap 1
 *    seeks to the event's detected frame (flash; null detected = arm without
 *    seeking) and the hint becomes "tap again to mark f{N}"; tap 2 stamps the
 *    CURRENT playhead frame. Stamped chip shows ✓ + frame; tap re-stamps at
 *    the playhead (latest wins). Arming clears when another chip is tapped.
 *  - Delta rows: "Auto f59 / You f57" — tap seeks to the detected frame
 *    (paused, chip flash); |Δ| > DELTA_WARN highlights (the batch ±3 gate).
 *  - Reset labels: two-state one-tap confirm. No long-press interactions.
 */

export type LabelEvent = {
  key: string;
  label: string;
  detectedFrame: number | null;
};

export type LabelSaveState = 'disabled' | 'ready' | 'saving' | 'saved';

const DELTA_WARN = 3;
const FLASH_MS = 600;

interface Props {
  events: LabelEvent[];
  frameCount: number;
  videoIdx: number;
  seekToFrame: (index: number, opts?: { autoPlay?: boolean }) => void;
  labels: Record<string, number | undefined>;
  onStamp: (key: string, frame: number) => void;
  onResetLabels: () => void;
  onSave?: () => void;
  saveButtonLabel: string;
  saveState: LabelSaveState;
  saveDisabledReason?: string;
}

export default function PhaseLabelBar({
  events,
  frameCount,
  videoIdx,
  seekToFrame,
  labels,
  onStamp,
  onResetLabels,
  onSave,
  saveButtonLabel,
  saveState,
  saveDisabledReason,
}: Props) {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [frameInputOpen, setFrameInputOpen] = useState(false);
  const [frameInputText, setFrameInputText] = useState('');
  const [resetArmed, setResetArmed] = useState(false);

  const clampFrame = (f: number) => Math.min(Math.max(0, f), Math.max(0, frameCount - 1));
  const step = (delta: number) => {
    setResetArmed(false);
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
    setResetArmed(false);
    const stamped = labels[ev.key] != null;
    if (stamped) {
      onStamp(ev.key, videoIdx); // re-stamp at playhead, latest wins
      setArmedKey(null);
      return;
    }
    if (armedKey === ev.key) {
      onStamp(ev.key, videoIdx); // tap 2: stamp current playhead frame
      setArmedKey(null);
    } else {
      setArmedKey(ev.key); // tap 1: arm + jump to the Auto frame
      seekToDetected(ev);
    }
  };

  const submitFrameInput = () => {
    const n = parseInt(frameInputText, 10);
    if (Number.isFinite(n)) seekToFrame(clampFrame(n), { autoPlay: false });
    setFrameInputOpen(false);
    setFrameInputText('');
  };

  const stampedCount = events.filter((ev) => labels[ev.key] != null).length;

  return (
    <View style={styles.container}>
      {/* Stepper */}
      <View style={styles.stepperRow}>
        <Pressable style={styles.stepBtn} onPress={() => step(-5)}>
          <Text style={styles.stepText}>−5</Text>
        </Pressable>
        <Pressable style={styles.stepBtn} onPress={() => step(-1)}>
          <Text style={styles.stepText}>−1</Text>
        </Pressable>
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
        <Pressable style={styles.stepBtn} onPress={() => step(1)}>
          <Text style={styles.stepText}>+1</Text>
        </Pressable>
        <Pressable style={styles.stepBtn} onPress={() => step(5)}>
          <Text style={styles.stepText}>+5</Text>
        </Pressable>
      </View>

      {/* Stamp chips */}
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
              <Text style={styles.chipHint}>
                {stamped != null
                  ? 'tap to re-mark'
                  : armed
                    ? `tap again to mark f${videoIdx}`
                    : 'tap to mark'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Delta rows */}
      {events.map((ev) => {
        const you = labels[ev.key];
        const auto = ev.detectedFrame;
        const delta = you != null && auto != null ? you - auto : null;
        const warn = delta != null && Math.abs(delta) > DELTA_WARN;
        return (
          <Pressable key={ev.key} style={styles.deltaRow} onPress={() => seekToDetected(ev)}>
            <Text style={[styles.deltaText, warn && styles.deltaWarn]}>
              {ev.label}: Auto {auto != null ? `f${auto}` : '—'} / You{' '}
              {you != null ? `f${you}` : '—'}
              {delta != null ? ` (Δ${delta > 0 ? '+' : ''}${delta})` : ''}
            </Text>
          </Pressable>
        );
      })}

      {/* Reset + Save */}
      <View style={styles.actionRow}>
        <Pressable
          style={[styles.resetBtn, resetArmed && styles.resetArmed]}
          onPress={() => {
            if (resetArmed) {
              onResetLabels();
              setResetArmed(false);
              setArmedKey(null);
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#141416',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  stepperRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 10,
  },
  stepBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  stepText: {
    color: '#FFF',
    fontSize: 14,
    fontFamily: 'Menlo',
    fontWeight: '700',
  },
  frameBox: {
    flex: 1.6,
    borderWidth: 1,
    borderColor: '#0A84FF',
    borderRadius: 8,
    paddingVertical: 10,
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
    paddingVertical: 8,
    textAlign: 'center',
  },
  chipRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 8,
    flexWrap: 'wrap',
  },
  chip: {
    flexGrow: 1,
    flexBasis: '30%',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 6,
    alignItems: 'center',
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
    color: '#888',
    fontSize: 10,
    marginTop: 2,
  },
  deltaRow: {
    paddingVertical: 3,
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
});
