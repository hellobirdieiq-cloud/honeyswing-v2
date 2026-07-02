/**
 * useSettingsData — the settings screen's hydration layer, extracted VERBATIM
 * from settings.tsx (Batch 5.3): the on-focus loader fan-out (re-read on focus,
 * not just mount, so changes made elsewhere are reflected when the screen
 * regains focus) plus the six hydrated states and the deduped profiles refetch.
 *
 * `user` is passed through as the object (not user.id) so the focus-effect dep
 * identity semantics stay byte-identical to the original [isSignedIn, user].
 */
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { getCoachCode } from '../../lib/coachCode';
import { checkIsCoach } from '../../lib/referralAttribution';
import { getIsLeftHanded } from '../../lib/handedness';
import { getWatchCaptureEnabled } from '../../lib/watchCaptureSetting';
import { getAgeTier, type AgeTier } from '../../lib/ageTier';
import { getProfiles, type PlayerProfile } from '../../lib/playerProfiles';

export function useSettingsData(
  isSignedIn: boolean | undefined,
  user: { id: string } | null | undefined,
) {
  const [coachName, setCoachName] = useState<string | null>(null);
  const [isLeftHanded, setIsLeftHandedState] = useState(false);
  const [watchCapture, setWatchCaptureState] = useState(false);
  const [ageTier, setAgeTierState] = useState<AgeTier>('youth');
  const [isCoach, setIsCoach] = useState(false);
  const [profiles, setProfiles] = useState<PlayerProfile[]>([]);

  /**
   * The refetch-after-mutation pattern, deduped (was repeated at 3 CRUD sites).
   * Awaitable and THROWING on failure — callers await it inside their own
   * try/catch, exactly like the inline `setProfiles(await getProfiles())` it
   * replaces (sequencing and error routing unchanged).
   */
  const refreshProfiles = useCallback(async () => {
    setProfiles(await getProfiles());
  }, []);

  useFocusEffect(
    useCallback(() => {
      getCoachCode().then((code) => setCoachName(code)).catch((err) => console.error('[HoneySwing]', err));
      getIsLeftHanded().then(setIsLeftHandedState).catch((err) => console.error('[HoneySwing]', err));
      getWatchCaptureEnabled().then(setWatchCaptureState).catch((err) => console.error('[HoneySwing]', err));
      getAgeTier().then(setAgeTierState).catch((err) => console.error('[HoneySwing]', err));
      getProfiles().then(setProfiles).catch((err) => console.error('[HoneySwing]', err));

      checkIsCoach(isSignedIn && user ? user.id : null)
        .then(setIsCoach)
        .catch((err) => console.error('[HoneySwing]', err));
    }, [isSignedIn, user]),
  );

  return {
    coachName,
    setCoachName,
    isLeftHanded,
    setIsLeftHandedState,
    watchCapture,
    setWatchCaptureState,
    ageTier,
    setAgeTierState,
    isCoach,
    profiles,
    setProfiles,
    refreshProfiles,
  };
}
