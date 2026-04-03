import Purchases, {
  type CustomerInfo,
  type PurchasesOfferings,
  LOG_LEVEL,
} from 'react-native-purchases';

// ── Constants ────────────────────────────────────────────────────────────────
const REVENUECAT_API_KEY = 'appl_UTzTUForArVybmyrdCmPOnGErQo';
export const ENTITLEMENT_ID = 'pro';
export const OFFERING_ID = 'default';

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

// ── Entitlement Check ────────────────────────────────────────────────────────

export async function getSubscriptionStatus(): Promise<boolean> {
  try {
    const info: CustomerInfo = await Purchases.getCustomerInfo();
    return info.entitlements.active[ENTITLEMENT_ID] !== undefined;
  } catch (e) {
    console.error('[HoneySwing] RevenueCat getCustomerInfo error:', e);
    // Default-allow: a paying user with bad signal must never see the paywall.
    // Existing tier logic in swingLimit.ts is the safety net for non-subscribers.
    return true;
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
