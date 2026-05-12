import type { KidProfile } from '@/packages/domain/clinic/KidProfile';

let queue: KidProfile[] = [];

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyListeners(): void {
  listeners.forEach((l) => l());
}

// Returns the queue in order. Read-only copy — mutating the result has no effect on the store.
export function getQueue(): KidProfile[] {
  return queue.slice();
}

// Returns the head of the queue without removing it, or null when empty.
export function peekNext(): KidProfile | null {
  return queue.length > 0 ? queue[0] : null;
}

// Appends a kid to the queue. No-op when the profile id is already present.
export function enqueueKid(profile: KidProfile): void {
  if (queue.some((k) => k.id === profile.id)) return;
  queue = [...queue, profile];
  notifyListeners();
}

// Removes and returns the head of the queue, or null when empty.
export function dequeueNext(): KidProfile | null {
  if (queue.length === 0) return null;
  const [head, ...rest] = queue;
  queue = rest;
  notifyListeners();
  return head;
}

// Removes a kid from the queue by id. No-op when not present.
export function removeFromQueue(kidId: string): void {
  const next = queue.filter((k) => k.id !== kidId);
  if (next.length === queue.length) return;
  queue = next;
  notifyListeners();
}

// Reorders the queue to match the given id list. Ids not currently in the queue are ignored;
// queue entries whose ids are missing from the input are dropped to the tail in their original order.
export function reorderQueue(orderedIds: string[]): void {
  const byId = new Map(queue.map((k) => [k.id, k]));
  const ordered: KidProfile[] = [];
  for (const id of orderedIds) {
    const k = byId.get(id);
    if (k) {
      ordered.push(k);
      byId.delete(id);
    }
  }
  const remaining = queue.filter((k) => byId.has(k.id));
  queue = [...ordered, ...remaining];
  notifyListeners();
}

// Clears the queue (test/debug only).
export function clearQueue(): void {
  console.warn('[kidQueueStore] clearQueue called — test/debug only');
  queue = [];
  notifyListeners();
}
