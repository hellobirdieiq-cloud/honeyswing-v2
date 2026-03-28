# Track C — Open Questions

**Date:** 2026-03-28
**Status:** To be resolved during implementation

---

### OQ-1: App Privacy exact category for coach_name [MUST RESOLVE BEFORE STEP 8]

**Context:** `coach_name` is a user-entered code that resolves to a coach display name, stored on the `swings` table linked to `user_id`. This may classify as "Data Linked to You" under Apple's App Privacy framework.

**Action:** During Step 8 (App Privacy update), review the exact Apple privacy category definitions against the shipped implementation. Determine whether `coach_name` falls under "Identifiers", "Usage Data", or another category. The working expectation is that "Data Not Collected" is no longer accurate, but the final answer depends on the specific category mapping.

---

### OQ-2: Invalid coach code UX feedback [BONUS — not blocking]

**Context:** When a user enters a code that doesn't match any key in `CODE_TO_NAME`, `resolveCoachName` returns null. The current plan has no explicit user feedback for this case — the coach row simply stays in the "Link a Coach" state.

**Action:** Decide during Step 4 implementation whether to show a brief inline message (e.g., "Code not recognized") or silently ignore. This is a BONUS item and does not block the release.

---

### OQ-3: Coach code entry when coach is already linked [BONUS — not blocking]

**Context:** The plan calls for a tappable row + modal. When a coach is already linked, the UX for changing or clearing the code is not explicitly specified.

**Action:** Decide during Step 4 implementation. Options: (a) modal pre-fills current code, user can edit or clear, (b) separate "Unlink" action. This is a BONUS item.

---

### OQ-4: Device test — Home screen layout on iPhone SE [DEVICE-TEST REQUIRED]

**Context:** Prompt 2 calculated ~352px total content height vs ~520px available on iPhone SE. This is a paper calculation. The focus card is conditional (only renders when focus exists), so the worst case is when all elements render.

**Action:** After Step 4, test on iPhone SE simulator with a focus card active. Verify no content is clipped or pushed off-screen. If it is, adjust margins — do NOT convert to ScrollView.
