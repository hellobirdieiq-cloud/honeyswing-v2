/**
 * Module-scoped lock to prevent multiple actors from racing
 * router.replace() during magic-link cold start.
 */
let hasNavigated = false;

export function tryNavigate(): boolean {
  if (hasNavigated) return false;
  hasNavigated = true;
  return true;
}

export function resetNavigationLock(): void {
  hasNavigated = false;
}