import { useState, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter, useFocusEffect, type Href } from 'expo-router';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useUser, useAuth } from '@clerk/expo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from '../../lib/storageKeys';
import { deleteAccount, supabase } from '../../lib/supabase';
import { getCoachCode } from '../../lib/coachCode';
import { getGrip } from '../../lib/gripStore';
import { linkCoach, unlinkCoach } from '../../lib/referralAttribution';
import { getIsLeftHanded, setIsLeftHanded } from '../../lib/handedness';
import { restorePurchases, ENTITLEMENT_ID } from '../../lib/purchases';
import { getAgeTier, setAgeTier as persistAgeTier, type AgeTier } from '../../lib/ageTier';
import { tipFrequencyLimiter } from '../../lib/tipFrequency';
import { GOLD } from '../../lib/colors';

const AGE_TIER_LABELS: Record<AgeTier, string> = {
  junior: 'Little Kid (6-8)',
  youth: 'Kid (9-12)',
  teen: 'Teen (13-17)',
  adult: 'Adult (18+)',
};

export default function SettingsScreen() {
  const router = useRouter();
  const { user, isLoaded, isSignedIn } = useUser();
  const { signOut } = useAuth();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const [deleting, setDeleting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [coachName, setCoachName] = useState<string | null>(null);
  const [coachLoading, setCoachLoading] = useState(false);
  const [isLeftHanded, setIsLeftHandedState] = useState(false);
  const [ageTier, setAgeTierState] = useState<AgeTier>('youth');
  const [gripUri, setGripUri] = useState<string | null>(null);
  const [isCoach, setIsCoach] = useState(false);

  useFocusEffect(
    useCallback(() => {
      getCoachCode().then((code) => setCoachName(code)).catch((err) => console.error('[HoneySwing]', err));
      getIsLeftHanded().then(setIsLeftHandedState).catch((err) => console.error('[HoneySwing]', err));
      getAgeTier().then(setAgeTierState).catch((err) => console.error('[HoneySwing]', err));
      const grip = getGrip();
      setGripUri(grip?.photoUri ?? null);

      (async () => {
        if (!isSignedIn || !user) { setIsCoach(false); return; }
        const { data } = await supabase
          .from('coaches')
          .select('id')
          .eq('auth_user_id', user.id)
          .maybeSingle();
        setIsCoach(!!data);
      })().catch((err) => console.error('[HoneySwing]', err));
    }, [isSignedIn, user]),
  );
  function handleAddCoach() {
    Alert.prompt(
      'Add Coach',
      'Enter your coach code',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Add',
          onPress: async (input?: string) => {
            if (!input?.trim()) return;
            setCoachLoading(true);
            try {
              const result = await linkCoach(input);
              if (result.success) {
                setCoachName(result.coachName!);
                Alert.alert('Coach Added', `Connected to coach ${result.coachName}`);
              } else {
                Alert.alert('Error', result.error ?? 'Something went wrong');
              }
            } catch {
              Alert.alert('Error', 'Something went wrong');
            } finally {
              setCoachLoading(false);
            }
          },
        },
      ],
      'plain-text',
    );
  }

  function handleRemoveCoach() {
    Alert.alert(
      'Remove Coach?',
      'This will disconnect you from your coach.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setCoachLoading(true);
            try {
              const result = await unlinkCoach();
              if (result.success) {
                setCoachName(null);
              } else {
                Alert.alert('Error', result.error ?? 'Something went wrong');
              }
            } catch {
              Alert.alert('Error', 'Something went wrong');
            } finally {
              setCoachLoading(false);
            }
          },
        },
      ],
    );
  }

  async function handleCheckForUpdate() {
    setCheckingUpdate(true);
    try {
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable) {
        await Updates.fetchUpdateAsync();
        await Updates.reloadAsync();
      } else {
        Alert.alert('Up to Date', 'You are on the latest version.');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      Alert.alert('Update Check Failed', message);
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleRestore() {
    setRestoring(true);
    try {
      const info = await restorePurchases();
      if (info?.entitlements.active[ENTITLEMENT_ID]) {
        Alert.alert('Restored', 'Your subscription has been restored.');
      } else {
        Alert.alert('No Previous Purchases', 'No previous purchases found.');
      }
    } catch {
      Alert.alert('Restore Failed', 'Something went wrong. Please try again.');
    } finally {
      setRestoring(false);
    }
  }

  function handleSignOut() {
    Alert.alert('Sign Out?', 'You will need to sign in again to access your account.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          setSigningOut(true);
          try {
            await signOut();
            router.replace('/signin' as Href);
          } catch (err: unknown) {
            const message =
              err instanceof Error ? err.message : 'Something went wrong';
            Alert.alert('Error', message);
          } finally {
            setSigningOut(false);
          }
        },
      },
    ]);
  }

  function handleDelete() {
    Alert.alert(
      'Delete Account',
      'Are you sure? This will permanently delete your account and all swing data.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteAccount();
              await AsyncStorage.multiRemove([
                STORAGE_KEYS.onboardingComplete,
                STORAGE_KEYS.profileId,
                STORAGE_KEYS.isLeftHanded,
                STORAGE_KEYS.coachCode,
                STORAGE_KEYS.pendingReferralCode,
                STORAGE_KEYS.subscriptionStatus,
                STORAGE_KEYS.ageTier,
              ]);
              router.replace('/(tabs)/record' as Href);
            } catch (err: unknown) {
              const message =
                err instanceof Error ? err.message : 'Something went wrong';
              Alert.alert('Error', message);
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.accountSection}>
        <Text style={styles.coachLabel}>Account</Text>
        {!isLoaded ? (
          <ActivityIndicator color={GOLD} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
        ) : isSignedIn ? (
          <>
            <Text style={styles.coachStatus}>{email ?? 'Signed in'}</Text>
            <TouchableOpacity
              style={styles.signOutButton}
              onPress={handleSignOut}
              disabled={signingOut}
              activeOpacity={0.7}
            >
              <Text style={styles.signOutText}>
                {signingOut ? 'Signing Out...' : 'Sign Out'}
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.coachStatus}>Not signed in</Text>
            <TouchableOpacity
              style={styles.signInButton}
              onPress={() => router.push('/signin' as Href)}
              activeOpacity={0.7}
            >
              <Text style={styles.signInText}>Sign In</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      <TouchableOpacity
        style={styles.subscriptionButton}
        onPress={() => router.push('/paywall' as Href)}
        activeOpacity={0.7}
      >
        <Text style={styles.subscriptionText}>Subscription</Text>
        <Text style={styles.subscriptionHint}>Go Pro — unlimited swing analysis</Text>
      </TouchableOpacity>

      <View style={styles.coachSection}>
        <Text style={styles.coachLabel}>Coach</Text>
        <Text style={styles.coachStatus}>
          {coachName ? `Connected to Coach ${coachName}` : 'No coach linked'}
        </Text>
        {coachName ? (
          <TouchableOpacity
            style={styles.removeCoachButton}
            onPress={handleRemoveCoach}
            disabled={coachLoading}
            activeOpacity={0.7}
          >
            <Text style={styles.removeCoachText}>
              {coachLoading ? 'Removing...' : 'Remove Coach'}
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.addCoachButton}
            onPress={handleAddCoach}
            disabled={coachLoading}
            activeOpacity={0.7}
          >
            <Text style={styles.addCoachText}>
              {coachLoading ? 'Adding...' : 'Add Coach'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {isCoach && (
        <View style={styles.coachModeSection}>
          <Text style={styles.coachLabel}>Coach Mode</Text>
          <TouchableOpacity
            style={styles.coachModeButton}
            onPress={() => router.push('/clinic/preflight' as Href)}
            activeOpacity={0.7}
          >
            <Text style={styles.coachModeText}>Start Coach Mode</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.handednessSection}>
        <Text style={styles.coachLabel}>Grip</Text>
        <TouchableOpacity
          style={styles.gripBtn}
          onPress={() => router.push('/grip/capture' as Href)}
          activeOpacity={0.8}
        >
          {gripUri ? (
            <Image source={{ uri: gripUri }} style={styles.gripThumb} resizeMode="cover" />
          ) : null}
          <Text style={styles.gripBtnText}>
            {gripUri ? 'Update Grip Photo' : 'Capture Grip'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.handednessSection}>
        <Text style={styles.coachLabel}>Player age</Text>
        <View style={styles.ageTierRow}>
          {(Object.entries(AGE_TIER_LABELS) as [AgeTier, string][]).map(([tier, label]) => (
            <TouchableOpacity
              key={tier}
              style={[styles.ageTierOption, ageTier === tier && styles.optionSelected]}
              onPress={() => {
                setAgeTierState(tier);
                persistAgeTier(tier).catch((err) => console.error('[HoneySwing]', err));
                tipFrequencyLimiter.setAgeTier(tier);
              }}
              activeOpacity={0.7}
            >
              <Text style={[styles.ageTierText, ageTier === tier && styles.optionTextSelected]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.handednessSection}>
        <Text style={styles.coachLabel}>Dominant hand</Text>
        <View style={styles.toggleRow}>
          <TouchableOpacity
            style={[styles.toggleOption, !isLeftHanded && styles.optionSelected]}
            onPress={() => {
              setIsLeftHandedState(false);
              setIsLeftHanded(false);
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.optionText, !isLeftHanded && styles.optionTextSelected]}>
              Right-handed
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleOption, isLeftHanded && styles.optionSelected]}
            onPress={() => {
              setIsLeftHandedState(true);
              setIsLeftHanded(true);
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.optionText, isLeftHanded && styles.optionTextSelected]}>
              Left-handed
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.restoreSection}>
        <TouchableOpacity
          style={styles.restoreButton}
          onPress={handleRestore}
          disabled={restoring}
          activeOpacity={0.7}
        >
          <Text style={styles.restoreText}>
            {restoring ? 'Restoring...' : 'Restore Purchases'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <TouchableOpacity
          style={styles.deleteButton}
          onPress={handleDelete}
          activeOpacity={0.8}
          disabled={deleting}
        >
          {deleting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.deleteText}>Delete My Account</Text>
          )}
        </TouchableOpacity>
        <Text style={styles.deleteHint}>
          This will permanently remove your profile and all swing data.
        </Text>
      </View>

      <TouchableOpacity
        style={styles.updateButton}
        onPress={handleCheckForUpdate}
        disabled={checkingUpdate}
        activeOpacity={0.7}
      >
        <Text style={styles.updateButtonText}>
          {checkingUpdate ? 'Checking...' : 'Check for Update'}
        </Text>
      </TouchableOpacity>

      <Text style={styles.versionText}>
        v{Constants.expoConfig?.version ?? '?'} · rt {Updates.runtimeVersion ?? '?'} · {Updates.updateId ? Updates.updateId.slice(0, 8) : 'embedded'}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  accountSection: {
    marginTop: 0,
  },
  signOutButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
  },
  signOutText: {
    color: '#CC2222',
    fontSize: 14,
    fontWeight: '500',
  },
  signInButton: {
    marginTop: 12,
    backgroundColor: GOLD,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignSelf: 'flex-start',
  },
  signInText: {
    color: '#111',
    fontSize: 15,
    fontWeight: '700',
  },
  subscriptionButton: {
    marginTop: 32,
    backgroundColor: '#1A1A1C',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderWidth: 2,
    borderColor: GOLD,
  },
  subscriptionText: {
    color: GOLD,
    fontSize: 17,
    fontWeight: '700',
  },
  subscriptionHint: {
    color: '#999',
    fontSize: 13,
    marginTop: 4,
  },
  container: {
    flexGrow: 1,
    backgroundColor: '#111',
    padding: 24,
    paddingTop: 80,
  },
  title: {
    color: GOLD,
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 8,
  },
  coachSection: {
    marginTop: 32,
  },
  coachLabel: {
    color: '#999',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  coachStatus: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
  },
  removeCoachButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
  },
  removeCoachText: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
  },
  addCoachButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: GOLD,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
  },
  addCoachText: {
    color: GOLD,
    fontSize: 14,
    fontWeight: '500',
  },
  coachModeSection: {
    marginTop: 32,
  },
  coachModeButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: GOLD,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
  },
  coachModeText: {
    color: GOLD,
    fontSize: 14,
    fontWeight: '500',
  },
  ageTierRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  ageTierOption: {
    backgroundColor: '#1A1A1C',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  ageTierText: {
    color: '#999',
    fontSize: 13,
    fontWeight: '600',
  },
  handednessSection: {
    marginTop: 32,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 10,
  },
  toggleOption: {
    flex: 1,
    backgroundColor: '#1A1A1C',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  optionSelected: {
    borderColor: GOLD,
  },
  optionText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#999',
  },
  optionTextSelected: {
    color: '#fff',
  },
  restoreSection: {
    marginTop: 32,
  },
  restoreButton: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
  },
  restoreText: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
  },
  section: {
    marginTop: 'auto',
    marginBottom: 60,
  },
  deleteButton: {
    backgroundColor: '#CC2222',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  deleteText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  deleteHint: {
    color: '#666',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 12,
  },
  gripBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(245, 166, 35, 0.2)',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    marginBottom: 12,
    gap: 12,
  },
  gripBtnText: {
    color: GOLD,
    fontSize: 14,
    fontWeight: '600',
  },
  gripThumb: {
    width: 36,
    height: 36,
    borderRadius: 6,
    backgroundColor: '#333',
  },
  updateButton: {
    marginTop: 24,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'center',
  },
  updateButtonText: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
  },
  versionText: {
    marginTop: 8,
    marginBottom: 16,
    textAlign: 'center',
    color: '#666',
    fontSize: 12,
  },
});
