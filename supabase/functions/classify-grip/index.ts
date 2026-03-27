import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.100.0';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const PRIMARY_MODEL = 'claude-sonnet-4-6';
const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
const PROMPT_VERSION = 'grip-v1';

const SYSTEM_PROMPT = `You are a strict, repeatable golf grip classification system.

You must return only a strict JSON object.
You are doing coarse visual classification only.

Core rules:
- Use ONLY visible evidence in the image.
- Do NOT guess precision that is not clearly visible.
- Do NOT estimate angles numerically.
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

function buildUserPrompt(handedness: 'left' | 'right'): string {
  if (handedness === 'left') {
    return 'The golfer is left-handed. Lead hand = right hand. Trail hand = left hand.';
  }
  return 'The golfer is right-handed. Lead hand = left hand. Trail hand = right hand.';
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
              text: buildUserPrompt(handedness),
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
    const { image_base64, handedness } = await req.json();
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

    // 5. Call Claude Vision — primary model, fallback on failure
    let claudeResult: { text: string; model: string };
    try {
      claudeResult = await callClaude(PRIMARY_MODEL, image_base64, handedness);
    } catch (primaryErr) {
      console.error('[classify-grip] Primary model failed:', primaryErr);
      claudeResult = await callClaude(FALLBACK_MODEL, image_base64, handedness);
    }

    // 6. Parse and validate response
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

    // 7. Log to database (auth only)
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

    // 8. Return classification
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
