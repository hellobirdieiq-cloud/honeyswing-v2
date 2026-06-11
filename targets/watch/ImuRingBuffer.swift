import Foundation

// Fixed-capacity rolling buffer of ImuSample. When full, append overwrites the
// OLDEST sample — capture never stops on fill. snapshot() returns the retained
// window (≤ RING_BUFFER_SECONDS) in chronological order.
//
// Not thread-safe: the owner (ImuCapture) confines all access to one serial queue.
final class ImuRingBuffer {
    private var storage: [ImuSample]
    private var head = 0      // index of next write
    private var count = 0     // valid samples currently held
    private let capacity: Int

    init(capacity: Int = WatchImuConstants.ringCapacity) {
        self.capacity = max(1, capacity)
        storage = [ImuSample]()
        storage.reserveCapacity(self.capacity)
    }

    func append(_ sample: ImuSample) {
        if storage.count < capacity {
            storage.append(sample)
        } else {
            storage[head] = sample
        }
        head = (head + 1) % capacity
        if count < capacity { count += 1 }
    }

    /// Chronological copy of the retained window (oldest → newest).
    func snapshot() -> [ImuSample] {
        guard count > 0 else { return [] }
        if count < capacity {
            // Not wrapped yet: storage[0..<count] is already chronological.
            return Array(storage[0..<count])
        }
        // Wrapped: oldest is at head, newest at head-1.
        let tail = Array(storage[head..<capacity])
        let front = Array(storage[0..<head])
        return tail + front
    }

    func reset() {
        storage.removeAll(keepingCapacity: true)
        head = 0
        count = 0
    }
}
