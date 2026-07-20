/**
 * hapticTick.ts — best-effort light impact for scrub band crossings (FIX 6c).
 *
 * The repo ships NO haptics package; per spec the tick is SKIPPED SILENTLY
 * when unavailable. requireOptionalNativeModule resolves the ExpoHaptics
 * native module only if expo-haptics is ever installed — today it returns
 * null and every call is a no-op. No new dependencies.
 */
import { requireOptionalNativeModule } from 'expo';

const ExpoHaptics = requireOptionalNativeModule<{
  impactAsync(style: string): Promise<void>;
}>('ExpoHaptics');

export function lightImpact(): void {
  ExpoHaptics?.impactAsync('light').catch(() => {});
}
