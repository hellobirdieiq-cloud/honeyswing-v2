import Purchases, {
  type CustomerInfo,
  type PurchasesOfferings,
  LOG_LEVEL,
} from 'react-native-purchases';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Constants ────────────────────────────────────────────────────────────────
const REVENUECAT_API_KEY = 'appl_UTzTUForArVybmyrdCmPOnGErQo';
export const ENTITLEMENT_ID = 'pro';
export const OFFERING_ID = 'default';
const CACHE_KEY = 'honeyswing:subscriptionStatus';

// ── SDK Init ─────────────────────────────────────────────────────────────────

let configured = false;

export function configurePurchases(): void {
  if (configured) return;
  Purchases.configure({ apiKey: REVENUECAT_API_KEY });
  if (__DEV__) {
    Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  }
  configured = true;
}

// ── Auth Sync ────────────────────────────────────────────────────────────────

export async function syncAuthState(userId: string | null): Promise<void> {
  try {
    if (userId) {
      await Purchases.logIn(userId);
    } else {
      await Purchases.logOut();
    }
  } catch (e) {
    console.error('[HoneySwing] RevenueCat auth sync error:', e);
  }
}

// ── Entitlement Cache ────────────────────────────────────────────────────────

async function cacheStatus(isSubscribed: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(isSubscribed));
  } catch {
    // Cache write failure is non-critical
  }
}

async function getCachedStatus(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (raw === null) return false;
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

// ── Entitlement Check ────────────────────────────────────────────────────────

export async function getSubscriptionStatus(): Promise<boolean> {
  try {
    const info: CustomerInfo = await Purchases.getCustomerInfo();
    const isSubscribed = info.entitlements.active[ENTITLEMENT_ID] !== undefined;
    await cacheStatus(isSubscribed);
    return isSubscribed;
  } catch (e) {
    console.error('[HoneySwing] RevenueCat getCustomerInfo error, using cached status:', e);
    return getCachedStatus();
  }
}

// ── Offerings ────────────────────────────────────────────────────────────────

export async function getOfferings(): Promise<PurchasesOfferings | null> {
  try {
    const offerings = await Purchases.getOfferings();
    return offerings;
  } catch (e) {
    console.error('[HoneySwing] RevenueCat getOfferings error:', e);
    return null;
  }
}

// ── Restore ──────────────────────────────────────────────────────────────────

export async function restorePurchases(): Promise<CustomerInfo | null> {
  try {
    const info = await Purchases.restorePurchases();
    return info;
  } catch (e) {
    console.error('[HoneySwing] RevenueCat restorePurchases error:', e);
    return null;
  }
}
