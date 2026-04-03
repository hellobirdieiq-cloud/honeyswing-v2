import { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { Linking } from 'react-native';
import Purchases, { type PurchasesPackage } from 'react-native-purchases';
import { getOfferings, restorePurchases, ENTITLEMENT_ID } from '../lib/purchases';

export default function PaywallScreen() {
  const router = useRouter();
  const [monthly, setMonthly] = useState<PurchasesPackage | null>(null);
  const [annual, setAnnual] = useState<PurchasesPackage | null>(null);
  const [selected, setSelected] = useState<'monthly' | 'annual'>('annual');
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    getOfferings().then((offerings) => {
      const current = offerings?.current;
      if (current) {
        setMonthly(current.monthly ?? null);
        setAnnual(current.annual ?? null);
      }
      setLoading(false);
    });
  }, []);

  async function handlePurchase() {
    const pkg = selected === 'annual' ? annual : monthly;
    if (!pkg) return;

    setPurchasing(true);
    try {
      const result = await Purchases.purchasePackage(pkg);
      if (result.customerInfo.entitlements.active[ENTITLEMENT_ID]) {
        router.replace('/(tabs)/record' as Href);
      }
    } catch (e: any) {
      if (e.userCancelled) {
        // User tapped cancel — do nothing
      } else {
        Alert.alert('Purchase Failed', 'Something went wrong. Please try again.');
      }
    } finally {
      setPurchasing(false);
    }
  }

  async function handleRestore() {
    setRestoring(true);
    try {
      const info = await restorePurchases();
      if (info?.entitlements.active[ENTITLEMENT_ID]) {
        router.replace('/(tabs)/record' as Href);
      } else {
        Alert.alert('No Previous Purchases', 'No previous purchases found.');
      }
    } catch {
      Alert.alert('Restore Failed', 'Something went wrong. Please try again.');
    } finally {
      setRestoring(false);
    }
  }

  const monthlyPrice = monthly?.product.priceString ?? '$9.99';
  const annualPrice = annual?.product.priceString ?? '$59.99';
  const annualMonthly = annual
    ? `$${(annual.product.price / 12).toFixed(2)}/mo`
    : '$5.00/mo'; // TODO: fallback is hardcoded

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>HoneySwing Pro</Text>
        <Text style={styles.subtitle}>Unlimited swing analysis</Text>
      </View>

      <View style={styles.features}>
        <Text style={styles.featureItem}>Unlimited swings</Text>
        <Text style={styles.featureItem}>Full biomechanical scoring</Text>
        <Text style={styles.featureItem}>Visual Coach feedback</Text>
        <Text style={styles.featureItem}>Slow-mo video replay</Text>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#F5A623" style={styles.loader} />
      ) : (
        <View style={styles.plans}>
          <TouchableOpacity
            style={[styles.planCard, selected === 'annual' && styles.planSelected]}
            onPress={() => setSelected('annual')}
            activeOpacity={0.7}
          >
            <View style={styles.planBadge}>
              <Text style={styles.planBadgeText}>Best Value</Text>
            </View>
            <Text style={styles.planName}>Annual</Text>
            <Text style={styles.planPrice}>{annualPrice}/yr</Text>
            <Text style={styles.planDetail}>{annualMonthly}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.planCard, selected === 'monthly' && styles.planSelected]}
            onPress={() => setSelected('monthly')}
            activeOpacity={0.7}
          >
            <Text style={styles.planName}>Monthly</Text>
            <Text style={styles.planPrice}>{monthlyPrice}/mo</Text>
          </TouchableOpacity>
        </View>
      )}

      <TouchableOpacity
        style={[styles.subscribeButton, (purchasing || loading) && styles.buttonDisabled]}
        onPress={handlePurchase}
        disabled={purchasing || loading}
        activeOpacity={0.8}
      >
        {purchasing ? (
          <ActivityIndicator color="#111" />
        ) : (
          <Text style={styles.subscribeText}>Subscribe</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.dismissButton}
        onPress={() => router.replace('/(tabs)' as Href)}
        activeOpacity={0.7}
      >
        <Text style={styles.dismissText}>Not now</Text>
      </TouchableOpacity>

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

      <Text style={styles.terms}>
        Payment will be charged to your Apple ID account at confirmation of purchase. Subscription
        automatically renews unless cancelled at least 24 hours before the end of the current period.
      </Text>

      <View style={styles.legalLinks}>
        <TouchableOpacity onPress={() => Linking.openURL('https://honeyswing.com/terms')}>
          <Text style={styles.legalLinkText}>Terms of Use</Text>
        </TouchableOpacity>
        <Text style={styles.legalSeparator}>|</Text>
        <TouchableOpacity onPress={() => Linking.openURL('https://honeyswing.com/privacy')}>
          <Text style={styles.legalLinkText}>Privacy Policy</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    padding: 24,
    paddingTop: 80,
    alignItems: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  title: {
    color: '#F5A623',
    fontSize: 32,
    fontWeight: '800',
    marginBottom: 8,
  },
  subtitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '500',
  },
  features: {
    alignSelf: 'stretch',
    backgroundColor: '#1A1A1C',
    borderRadius: 14,
    padding: 20,
    marginBottom: 32,
    gap: 12,
  },
  featureItem: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
  },
  loader: {
    marginVertical: 40,
  },
  plans: {
    flexDirection: 'row',
    gap: 12,
    alignSelf: 'stretch',
    marginBottom: 24,
  },
  planCard: {
    flex: 1,
    backgroundColor: '#1A1A1C',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  planSelected: {
    borderColor: '#F5A623',
  },
  planBadge: {
    backgroundColor: '#F5A623',
    borderRadius: 6,
    paddingVertical: 2,
    paddingHorizontal: 8,
    marginBottom: 8,
  },
  planBadgeText: {
    color: '#111',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  planName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  planPrice: {
    color: '#F5A623',
    fontSize: 20,
    fontWeight: '800',
  },
  planDetail: {
    color: '#999',
    fontSize: 13,
    marginTop: 2,
  },
  subscribeButton: {
    backgroundColor: '#F5A623',
    borderRadius: 16,
    paddingVertical: 18,
    alignSelf: 'stretch',
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  subscribeText: {
    color: '#111',
    fontSize: 20,
    fontWeight: '700',
  },
  dismissButton: {
    paddingVertical: 12,
  },
  dismissText: {
    color: '#999',
    fontSize: 16,
    fontWeight: '500',
  },
  restoreButton: {
    paddingVertical: 8,
  },
  restoreText: {
    color: '#666',
    fontSize: 14,
    fontWeight: '500',
  },
  terms: {
    color: '#666',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 16,
    marginTop: 'auto',
    marginBottom: 8,
    paddingHorizontal: 12,
  },
  legalLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 20,
  },
  legalLinkText: {
    color: '#999',
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  legalSeparator: {
    color: '#666',
    fontSize: 12,
  },
});
