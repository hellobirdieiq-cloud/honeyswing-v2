import Constants from 'expo-constants';

/**
 * App version stamped on persisted swing rows and analytics events. Derived from
 * app.json (`expo.version`) so it tracks the shipped/OTA version automatically —
 * previously hardcoded literals ('1.10.0' on rows, '1.9.4' on events) drifted
 * from the real version and broke version-cohort analytics. Matches the version
 * surfaced on the Settings screen (Constants.expoConfig?.version).
 */
export const APP_VERSION =
  Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? '0.0.0';
