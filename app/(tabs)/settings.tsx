import { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { useRouter, useFocusEffect, type Href } from 'expo-router';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useUser, useAuth } from '@clerk/expo';
import { getCoachCode } from '../../lib/coachCode';
import { linkCoach, unlinkCoach, checkIsCoach } from '../../lib/referralAttribution';
import { getIsLeftHanded, setIsLeftHanded } from '../../lib/handedness';
import { getWatchCaptureEnabled, setWatchCaptureEnabled } from '../../lib/watchCaptureSetting';
import { restorePurchases, ENTITLEMENT_ID } from '../../lib/purchases';
import { getAgeTier, applyAgeTier, type AgeTier } from '../../lib/ageTier';
import { getProfiles, addProfile, deleteProfile, saveProfiles, setPrimaryProfile, type PlayerProfile } from '../../lib/playerProfiles';
import { deleteAccountAndPurgeLocal } from '../../lib/accountLifecycle';
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
  const [watchCapture, setWatchCaptureState] = useState(false);
  const [ageTier, setAgeTierState] = useState<AgeTier>('youth');
  const [isCoach, setIsCoach] = useState(false);
  const [profiles, setProfiles] = useState<PlayerProfile[]>([]);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerIsLeft, setNewPlayerIsLeft] = useState(false);

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
              await deleteAccountAndPurgeLocal();
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
        <Text style={styles.coachLabel}>Player age</Text>
        <View style={styles.ageTierRow}>
          {(Object.entries(AGE_TIER_LABELS) as [AgeTier, string][]).map(([tier, label]) => (
            <TouchableOpacity
              key={tier}
              style={[styles.ageTierOption, ageTier === tier && styles.optionSelected]}
              onPress={() => {
                setAgeTierState(tier);
                applyAgeTier(tier).catch((err) => console.error('[HoneySwing]', err));
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
        <Text style={styles.coachLabel}>Players</Text>
        {profiles.map((p) => {
          const needsNickname = p.name.length > 7;
          const nicknameEmpty = !p.nickname || p.nickname.trim() === '';
          return (
            <View key={p.id}>
              <TouchableOpacity
                onPress={async () => {
                  try {
                    await setPrimaryProfile(p.id);
                    const next = await getProfiles();
                    setProfiles(next);
                  } catch (err) { console.error('[HoneySwing]', err); }
                }}
                activeOpacity={0.7}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}
              >
                <Text style={{ color: GOLD, marginRight: 8, fontSize: 15, width: 12 }}>
                  {p.isPrimary ? '●' : ' '}
                </Text>
                <Text style={{ flex: 1, color: '#fff', fontSize: 15 }}>{p.name}</Text>
                <Text style={{ color: '#999', marginRight: 12, fontSize: 13 }}>
                  {p.isLeftHanded ? 'Left-handed' : 'Right-handed'}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    Alert.alert(
                      `Delete ${p.name}?`,
                      '',
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete',
                          style: 'destructive',
                          onPress: async () => {
                            try {
                              await deleteProfile(p.id);
                              const next = await getProfiles();
                              setProfiles(next);
                            } catch (err) { console.error('[HoneySwing]', err); }
                          },
                        },
                      ],
                    );
                  }}
                  hitSlop={10}
                >
                  <Text style={{ color: '#999', fontSize: 18 }}>×</Text>
                </TouchableOpacity>
              </TouchableOpacity>
              {needsNickname && (
                <TextInput
                  value={p.nickname ?? ''}
                  onChangeText={(text) => {
                    const updated = profiles.map((q) =>
                      q.id === p.id ? { ...q, nickname: text } : q,
                    );
                    setProfiles(updated);
                    saveProfiles(updated).catch((err) => console.error('[HoneySwing]', err));
                  }}
                  placeholder="Nickname (required)"
                  placeholderTextColor="#666"
                  style={{
                    backgroundColor: '#1a1a1a',
                    color: '#fff',
                    borderRadius: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    fontSize: 14,
                    marginBottom: 8,
                    marginLeft: 20,
                    borderWidth: 1,
                    borderColor: nicknameEmpty ? GOLD : 'transparent',
                  }}
                />
              )}
            </View>
          );
        })}
        <View style={{ marginTop: 12 }}>
          <TextInput
            value={newPlayerName}
            onChangeText={setNewPlayerName}
            placeholder="Player name"
            placeholderTextColor="#666"
            style={{ backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 }}
          />
          <View style={[styles.toggleRow, { marginTop: 8 }]}>
            <TouchableOpacity
              style={[styles.toggleOption, !newPlayerIsLeft && styles.optionSelected]}
              onPress={() => setNewPlayerIsLeft(false)}
              activeOpacity={0.7}
            >
              <Text style={[styles.optionText, !newPlayerIsLeft && styles.optionTextSelected]}>Right-handed</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toggleOption, newPlayerIsLeft && styles.optionSelected]}
              onPress={() => setNewPlayerIsLeft(true)}
              activeOpacity={0.7}
            >
              <Text style={[styles.optionText, newPlayerIsLeft && styles.optionTextSelected]}>Left-handed</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            disabled={newPlayerName.trim() === ''}
            onPress={async () => {
              try {
                await addProfile(newPlayerName, newPlayerIsLeft);
                const next = await getProfiles();
                setProfiles(next);
                setNewPlayerName('');
                setNewPlayerIsLeft(false);
              } catch (err) { console.error('[HoneySwing]', err); }
            }}
            style={{ marginTop: 10, backgroundColor: newPlayerName.trim() === '' ? '#333' : GOLD, paddingVertical: 12, borderRadius: 8, alignItems: 'center', opacity: newPlayerName.trim() === '' ? 0.5 : 1 }}
          >
            <Text style={{ color: newPlayerName.trim() === '' ? '#666' : '#1A0E00', fontSize: 15, fontWeight: '600' }}>Add</Text>
          </TouchableOpacity>
        </View>
      </View>

      {profiles.length === 0 && (
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
      )}

      <View style={styles.handednessSection}>
        <Text style={styles.coachLabel}>Apple Watch capture (beta)</Text>
        <View style={styles.toggleRow}>
          <TouchableOpacity
            style={[styles.toggleOption, !watchCapture && styles.optionSelected]}
            onPress={() => {
              setWatchCaptureState(false);
              setWatchCaptureEnabled(false);
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.optionText, !watchCapture && styles.optionTextSelected]}>
              Off
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleOption, watchCapture && styles.optionSelected]}
            onPress={() => {
              setWatchCaptureState(true);
              setWatchCaptureEnabled(true);
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.optionText, watchCapture && styles.optionTextSelected]}>
              On
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
    color: '#1A0E00',
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
