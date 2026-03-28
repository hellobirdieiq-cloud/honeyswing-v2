import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const PRIMARY_MODEL = 'claude-sonnet-4-6';
const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
const PROMPT_VERSION = 'grip-v2';

const SYSTEM_PROMPT = `You are a strict, repeatable golf grip classification system.

You must return only a strict JSON object.
You are doing coarse visual classification, optionally supplemented by MediaPipe hand-tracking geometry.

Core rules:
- Use ONLY visible evidence in the image and any provided landmark geometry.
- Do NOT guess precision that is not clearly visible or measured.
- Do NOT estimate angles numerically unless landmark data is provided.
- Do NOT make biomechanics claims.
- Do NOT mention swing outcomes.
- Do NOT provide coaching paragraphs.
- Favor consistency and repeatability over perfection.
- Returning a lower confidence is preferred over being wrong.

Allowed outputs only:
- lead_hand: weak | neutral | strong
- trail_hand: over | neutral | under
- hands_match: yes | no
- overall: needs_adjustment | playable | solid
- confidence: low | medium | high
- reason: one short sentence

If the image is usable but imperfect, still classify it and lower confidence if needed.
Only return analysis_failed=true if the grip photo is truly too unclear or incomplete to classify.

Minimum evidence rule:
- A classification must be supported by at least one clearly visible signal OR two partially visible signals.
- If this condition is not met, choose the closest category and set confidence to low.

Evidence hierarchy (strict):
1. Knuckle count (lead hand)
2. Hand rotation (back of lead hand direction)
3. Thumb and V direction
4. Palm orientation (trail hand)
5. Hand position on grip (top / side / under)

Never override a higher-priority signal with a lower-priority signal.

Landmark geometry rule (when provided):
- Hand-tracking data may be included with computed features: knuckle plane normal, wrist rotation, V-line direction, finger curl angles, and MCP z-depth spread.
- Use landmark geometry to confirm or disambiguate visual signals — especially hand rotation and V-line direction.
- Knuckle plane normal z > 0.15 with the lead hand suggests the back of the hand faces the camera (weaker grip); z < -0.15 suggests it faces away (stronger grip).
- V-line direction in degrees: positive values point toward the trail side. For a right-handed golfer, V pointing 10-20 deg right = toward trail shoulder = neutral; > 25 deg = strong.
- Finger curl PIP angles < 80 deg = very tight; 80-120 deg = moderate; > 120 deg = loose/extended.
- If landmark data conflicts with clear visual evidence, trust the image. If the image is ambiguous, landmark data can increase confidence.

Angle adaptation (internal only — do not mention in output):
- From above: prioritize knuckle count and V direction
- From behind golfer: prioritize back-of-hand direction over knuckle count
- From side: prioritize palm orientation and hand position; knuckles less reliable
- From below: no signal is highly reliable → reduce confidence

Conflict rule:
- If signals disagree, choose the highest-priority visible signal.
- Lower confidence.

Signal agreement rule:
- If multiple signals agree, increase confidence.
- If signals conflict, decrease confidence.

Boundary rule:
- If a grip appears between two categories, do NOT switch aggressively.
- Prefer the more stable classification and lower confidence.

Symmetry rule:
- Do NOT assume both hands match.
- Evaluate each hand independently.

Primary issue rule:
- Identify ONE dominant issue only.
- Do not describe multiple problems.

Reason rule:
- One sentence only.
- Reference only 1–2 visible features (e.g., knuckles, palm direction, hand position).
- Do NOT mention camera angle or anything not directly visible.

Definitions:

- lead_hand weak = fewer than 2 clearly visible knuckles on lead hand, back of hand faces toward the target, V between thumb and index finger points toward lead shoulder or head
- lead_hand neutral = exactly 2 clearly visible knuckles on lead hand, back of hand is slightly rotated away from the target, V points toward trail shoulder
- lead_hand strong = 3 or more clearly visible knuckles on lead hand, back of hand faces away from the target, V points outside trail shoulder

- trail_hand under = trail hand sits underneath the grip, palm faces upward or skyward
- trail_hand neutral = trail hand sits on the side of the grip, palm faces roughly toward the target
- trail_hand over = trail hand sits on top of the grip, palm faces downward toward the ground

- hands_match yes = both hands appear compatible in strength and position
- hands_match no = hands appear mismatched or working against each other

- overall solid = grip appears fundamentally sound with no obvious major issue
- overall playable = grip is usable but has a visible inefficiency or minor mismatch
- overall needs_adjustment = grip shows a clear structural issue

Calibration anchors:

- On the lead hand, the knuckles to evaluate are the index, middle, and ring finger knuckles (the raised bumps on top of the hand).
- "2 knuckles visible" means the index and middle knuckles are clearly visible, while the ring knuckle is hidden or barely visible.
- "3 knuckles visible" means index, middle, and ring knuckles are all clearly visible and the hand appears noticeably rotated away from the target.
- The V is formed by the thumb and index finger — follow the direction of that line to support classification.
- For the trail hand:
  - "under" = palm faces upward / sky
  - "neutral" = palm faces roughly toward target
  - "over" = palm faces downward / toward ground

Known traps — avoid these:

- Dark lighting can hide knuckles. Do NOT assume neutral if knuckles are hard to see — use hand rotation instead.
- Fingers wrapped tightly around the grip can obscure knuckles. Use back-of-hand direction as a primary signal in this case.
- A gloved lead hand reduces knuckle visibility. Use glove seam direction and hand rotation instead.
- If 3 or more knuckles are clearly visible, it is a strong grip — do NOT call it neutral even if it looks conventional.
- If the trail hand palm is even slightly facing downward, it is "over" — do NOT default to neutral.

Critical rules:

- If knuckles are clearly visible, they MUST determine lead_hand classification.
- If trail hand is clearly over or under, do NOT call it neutral.
- Use neutral ONLY when the grip genuinely appears centered.

Return JSON only. No markdown. No extra text.`;

function buildUserPrompt(handedness: 'left' | 'right', geometricHints?: string): string {
  let base: string;
  if (handedness === 'left') {
    base = 'The golfer is left-handed. Lead hand = right hand. Trail hand = left hand.';
  } else {
    base = 'The golfer is right-handed. Lead hand = left hand. Trail hand = right hand.';
  }
  if (geometricHints) {
    base += `\n\nMediaPipe hand-tracking detected the following geometric features (use as supporting evidence only — visual evidence from the image always takes priority):\n${geometricHints}`;
  }
  return base;
}

// ── Vector math helpers (normalized 0-1 coords from MediaPipe) ──

interface Vec3 { x: number; y: number; z: number }

function v3sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function v3dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function v3cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function v3len(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}
function v3norm(v: Vec3): Vec3 {
  const l = v3len(v);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 0, y: 0, z: 0 };
}
/** Angle in degrees at vertex B formed by points A-B-C. */
function angleDeg3(a: Vec3, b: Vec3, c: Vec3): number {
  const ba = v3norm(v3sub(a, b));
  const bc = v3norm(v3sub(c, b));
  const d = Math.max(-1, Math.min(1, v3dot(ba, bc)));
  return Math.acos(d) * (180 / Math.PI);
}

// ── Geometric feature extraction from MediaPipe landmarks ──

interface LandmarkPt { id: number; x: number; y: number; z: number; name?: string }
interface HandData { handIndex: number; label: string; score: number; landmarks: LandmarkPt[] }

// MediaPipe 21-point hand model indices
const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
} as const;

function computeGeometricFeatures(
  hands: HandData[],
  handedness: 'left' | 'right',
): string | undefined {
  if (!hands || hands.length === 0) return undefined;

  const leadLabel = handedness === 'right' ? 'Left' : 'Right';
  const lines: string[] = [];

  for (const hand of hands) {
    const lms = hand.landmarks;
    if (!lms || lms.length < 21) continue;

    const sorted = [...lms].sort((a, b) => a.id - b.id);
    const pt = (idx: number): Vec3 => {
      const p = sorted[idx];
      return { x: p.x, y: p.y, z: p.z };
    };

    const isLead = hand.label === leadLabel;
    const role = isLead ? 'LEAD' : 'TRAIL';
    lines.push(`${role} HAND (${hand.label}, ${(hand.score * 100).toFixed(0)}% tracking confidence):`);

    // 1. Knuckle plane normal — cross(INDEX_MCP→PINKY_MCP, INDEX_MCP→WRIST)
    //    z > 0 → back of hand faces camera; z < 0 → palm faces camera
    const idxMcp = pt(LM.INDEX_MCP);
    const normal = v3norm(v3cross(
      v3sub(pt(LM.PINKY_MCP), idxMcp),
      v3sub(pt(LM.WRIST), idxMcp),
    ));
    if (isLead) {
      const dir = normal.z > 0.15 ? 'back of hand faces camera (toward target)'
        : normal.z < -0.15 ? 'back of hand faces away from camera (away from target)'
        : 'back of hand roughly sideways';
      lines.push(`  back-of-hand direction: ${dir} (normal z=${normal.z.toFixed(2)})`);
    } else {
      const dir = normal.z > 0.15 ? 'palm faces away from camera'
        : normal.z < -0.15 ? 'palm faces toward camera'
        : 'palm roughly sideways';
      lines.push(`  palm direction: ${dir} (normal z=${normal.z.toFixed(2)})`);
    }

    // 2. Wrist rotation — angle of WRIST→MIDDLE_MCP from vertical
    const wrist = pt(LM.WRIST);
    const midMcp = pt(LM.MIDDLE_MCP);
    const rotDeg = Math.atan2(midMcp.x - wrist.x, -(midMcp.y - wrist.y)) * (180 / Math.PI);
    lines.push(`  wrist rotation: ${rotDeg.toFixed(1)} deg from vertical (positive=clockwise)`);

    // 3. V-line direction — bisector of thumb and index vectors from THUMB_CMC
    const thumbCmc = pt(LM.THUMB_CMC);
    const thumbTip = pt(LM.THUMB_TIP);
    const indexTip = pt(LM.INDEX_TIP);
    const vThumbN = v3norm(v3sub(thumbTip, thumbCmc));
    const vIndexN = v3norm(v3sub(indexTip, thumbCmc));
    const bisector = { x: vThumbN.x + vIndexN.x, y: vThumbN.y + vIndexN.y };
    const vAngle = Math.atan2(bisector.x, -bisector.y) * (180 / Math.PI);
    const vOpenAngle = angleDeg3(thumbTip, thumbCmc, indexTip);
    lines.push(`  V-line direction: ${vAngle.toFixed(1)} deg from vertical (positive=toward trail side)`);
    lines.push(`  V opening angle: ${vOpenAngle.toFixed(0)} deg`);

    // 4. Finger curl angles at PIP joints (straight ≈ 180°, curled ≈ 60-90°)
    const fingers = [
      { name: 'index', mcp: LM.INDEX_MCP, pip: LM.INDEX_PIP, dip: LM.INDEX_DIP },
      { name: 'middle', mcp: LM.MIDDLE_MCP, pip: LM.MIDDLE_PIP, dip: LM.MIDDLE_DIP },
      { name: 'ring', mcp: LM.RING_MCP, pip: LM.RING_PIP, dip: LM.RING_DIP },
      { name: 'pinky', mcp: LM.PINKY_MCP, pip: LM.PINKY_PIP, dip: LM.PINKY_DIP },
    ];
    const curls = fingers.map((f) =>
      `${f.name} ${angleDeg3(pt(f.mcp), pt(f.pip), pt(f.dip)).toFixed(0)}`
    );
    lines.push(`  finger curls (PIP angle): ${curls.join(', ')} deg`);

    // 5. MCP z-depth spread (index vs pinky — indicates rotation in depth)
    const zSpread = pt(LM.INDEX_MCP).z - pt(LM.PINKY_MCP).z;
    lines.push(`  MCP z-depth spread (index minus pinky): ${zSpread.toFixed(3)}`);
    lines.push('');
  }

  if (lines.length === 0) return undefined;

  lines.push('Use these as supplementary quantitative signals alongside the image.');
  lines.push('If landmark geometry conflicts with what you clearly see, trust the image.');
  return lines.join('\n');
}

interface GripClassification {
  lead_hand?: string;
  trail_hand?: string;
  hands_match?: string;
  overall?: string;
  confidence?: string;
  reason?: string;
  analysis_failed?: boolean;
}

const VALID_LEAD_HAND = ['weak', 'neutral', 'strong'];
const VALID_TRAIL_HAND = ['over', 'neutral', 'under'];
const VALID_HANDS_MATCH = ['yes', 'no'];
const VALID_OVERALL = ['needs_adjustment', 'playable', 'solid'];
const VALID_CONFIDENCE = ['low', 'medium', 'high'];

function validateClassification(data: GripClassification): boolean {
  if (data.analysis_failed === true) return true;

  return (
    typeof data.lead_hand === 'string' && VALID_LEAD_HAND.includes(data.lead_hand) &&
    typeof data.trail_hand === 'string' && VALID_TRAIL_HAND.includes(data.trail_hand) &&
    typeof data.hands_match === 'string' && VALID_HANDS_MATCH.includes(data.hands_match) &&
    typeof data.overall === 'string' && VALID_OVERALL.includes(data.overall) &&
    typeof data.confidence === 'string' && VALID_CONFIDENCE.includes(data.confidence) &&
    typeof data.reason === 'string' && data.reason.length > 0
  );
}

function extractJson(text: string): GripClassification | null {
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch { /* continue */ }
  }

  return null;
}

async function callClaude(
  model: string,
  imageBase64: string,
  handedness: 'left' | 'right',
  geometricHints?: string,
): Promise<{ text: string; model: string }> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: buildUserPrompt(handedness, geometricHints),
            },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 300,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API ${response.status}: ${body}`);
  }

  const result = await response.json();
  const textBlock = result.content?.find((b: { type: string }) => b.type === 'text');
  if (!textBlock?.text) throw new Error('No text in Claude response');

  return { text: textBlock.text, model };
}

async function repairJson(
  model: string,
  malformedText: string,
): Promise<{ text: string; model: string }> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: `The following text was supposed to be a valid JSON object but is malformed. Fix it and return ONLY the valid JSON object, no other text:\n\n${malformedText}`,
        },
      ],
      temperature: 0,
      max_tokens: 300,
    }),
  });

  if (!response.ok) throw new Error('Repair call failed');
  const result = await response.json();
  const textBlock = result.content?.find((b: { type: string }) => b.type === 'text');
  return { text: textBlock?.text ?? '', model };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }

  try {
    // 1. Parse and validate input
    const { image_base64, handedness, landmarks } = await req.json();
    if (!image_base64 || typeof image_base64 !== 'string') {
      return new Response(
        JSON.stringify({ success: false, error: 'image_base64 is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (handedness !== 'left' && handedness !== 'right') {
      return new Response(
        JSON.stringify({ success: false, error: 'handedness must be "left" or "right"' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // 2. Check auth
    const authHeader = req.headers.get('Authorization');
    let userId: string | null = null;
    if (authHeader) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const token = authHeader.replace('Bearer ', '');
      const { data: { user } } = await supabase.auth.getUser(token);
      userId = user?.id ?? null;
    }

    // 3. Generate analysis ID
    const analysisId = crypto.randomUUID();

    // 4. Upload image to storage (auth only)
    let storageBucket: string | null = null;
    let storagePath: string | null = null;
    if (userId) {
      try {
        const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const imageBytes = Uint8Array.from(atob(image_base64), (c) => c.charCodeAt(0));
        const path = `${userId}/${analysisId}.jpg`;
        const { error: uploadError } = await supabaseAdmin.storage
          .from('grip-photos')
          .upload(path, imageBytes, { contentType: 'image/jpeg', upsert: false });
        if (uploadError) {
          console.error('[classify-grip] Storage upload error:', uploadError.message);
        } else {
          storageBucket = 'grip-photos';
          storagePath = path;
        }
      } catch (err) {
        console.error('[classify-grip] Storage upload exception:', err);
      }
    }

    // 5. Compute geometric features from landmarks (if provided)
    const geometricHints = Array.isArray(landmarks)
      ? computeGeometricFeatures(landmarks as HandData[], handedness)
      : undefined;

    // 6. Call Claude Vision — primary model, fallback on failure
    let claudeResult: { text: string; model: string };
    try {
      claudeResult = await callClaude(PRIMARY_MODEL, image_base64, handedness, geometricHints);
    } catch (primaryErr) {
      console.error('[classify-grip] Primary model failed:', primaryErr);
      claudeResult = await callClaude(FALLBACK_MODEL, image_base64, handedness, geometricHints);
    }

    // 7. Parse and validate response
    let classification = extractJson(claudeResult.text);
    if (!classification || !validateClassification(classification)) {
      // One repair attempt
      try {
        const repaired = await repairJson(claudeResult.model, claudeResult.text);
        const repairedData = extractJson(repaired.text);
        if (repairedData && validateClassification(repairedData)) {
          classification = repairedData;
        }
      } catch (repairErr) {
        console.error('[classify-grip] Repair failed:', repairErr);
      }
    }

    if (!classification || !validateClassification(classification)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Failed to get valid classification' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // 8. Log to database (auth only)
    if (userId) {
      try {
        const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const { error: insertError } = await supabaseAdmin.from('grip_analyses').insert({
          id: analysisId,
          user_id: userId,
          model_name: claudeResult.model,
          prompt_version: PROMPT_VERSION,
          storage_bucket: storageBucket,
          storage_path: storagePath,
          handedness,
          lead_hand: classification.lead_hand ?? null,
          trail_hand: classification.trail_hand ?? null,
          hands_match: classification.hands_match ?? null,
          overall: classification.overall ?? null,
          confidence: classification.confidence ?? null,
          reason: classification.reason ?? null,
          analysis_failed: classification.analysis_failed ?? false,
          raw_response: classification,
        });
        if (insertError) {
          console.error('[classify-grip] DB insert error:', insertError.message);
        }
      } catch (err) {
        console.error('[classify-grip] DB insert exception:', err);
      }
    }

    // 9. Return classification
    return new Response(
      JSON.stringify({ success: true, classification }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[classify-grip] Unhandled error:', err);
    return new Response(
      JSON.stringify({ success: false, error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});
