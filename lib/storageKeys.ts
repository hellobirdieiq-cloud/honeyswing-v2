/**
 * Centralized AsyncStorage key constants.
 * Every key used by the app lives here so typos are caught at compile time
 * and the logout/reset list in settings.tsx stays in sync.
 */

export const STORAGE_KEYS = {
  onboardingComplete: 'honeyswing:onboardingComplete',
  profileId: 'honeyswing:profileId',
  isLeftHanded: 'honeyswing:isLeftHanded',
  coachCode: 'honeyswing:coachCode',
  pendingReferralCode: 'honeyswing:pendingReferralCode',
  subscriptionStatus: 'honeyswing:subscriptionStatus',
  localSwingCount: 'honeyswing:localSwingCount',
  todaysFocus: 'honeyswing:todaysFocus',
  ageTier: 'honeyswing:ageTier',
  eventQueue: 'honeyswing:eventQueue',
  playerProfiles: 'honeyswing:playerProfiles',
  activeProfileId: 'honeyswing:activeProfileId',
} as const;
