import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DTL = [
  '31f52535-6d1b-4de3-8c36-171b2e158bc6',
  '6c421b84-d172-4f9a-8e12-e29ffa9e5eb4',
  '60125e2d-4a20-43be-9886-f9cd8422dca4',
];
const FACEON = [
  'd0343840-aa57-437e-a159-a30f162ec9eb',
  'ffc10eb5-65c4-4691-b309-76689e64f3c9',
  'a77579fe-d00e-45c0-944a-61d40dccf389',
];

const PAIRS = [
  ['leftShoulder', 'rightShoulder'],
  ['leftHip', 'rightHip'],
  ['leftKnee', 'rightKnee'],
  ['leftAnkle', 'rightAnkle'],
  ['leftElbow', 'rightElbow'],
  ['leftWrist', 'rightWrist'],
  ['leftHeel', 'rightHeel'],
  ['leftEar', 'rightEar'],
  ['leftEye', 'rightEye'],
  ['leftFootIndex', 'rightFootIndex'],
];

function avgSpreadForSwing(frames, jointA, jointB) {
  const spreads = frames
    .map(f => {
      const a = f.joints[jointA];
      const b = f.joints[jointB];
      if (!a || !b || a.confidence < 0.5 || b.confidence < 0.5) return null;
      return Math.abs(a.x - b.x);
    })
    .filter(v => v !== null);
  if (!spreads.length) return null;
  return spreads.reduce((a, b) => a + b, 0) / spreads.length;
}

const { data, error } = await supabase
  .from('swings')
  .select('id, motion_frames')
  .in('id', [...DTL, ...FACEON]);

if (error) {
  console.error('Supabase error:', error);
  process.exit(1);
}

const results = [];

for (const [jointA, jointB] of PAIRS) {
  const dtlSpreads = DTL.map(id => {
    const row = data.find(r => r.id === id);
    return row ? avgSpreadForSwing(row.motion_frames, jointA, jointB) : null;
  }).filter(Boolean);

  const faceonSpreads = FACEON.map(id => {
    const row = data.find(r => r.id === id);
    return row ? avgSpreadForSwing(row.motion_frames, jointA, jointB) : null;
  }).filter(Boolean);

  if (!dtlSpreads.length || !faceonSpreads.length) {
    results.push({ pair: `${jointA}/${jointB}`, dtlMean: null, faceonMean: null, ratio: null, gap: null });
    continue;
  }

  const dtlMean = dtlSpreads.reduce((a, b) => a + b, 0) / dtlSpreads.length;
  const faceonMean = faceonSpreads.reduce((a, b) => a + b, 0) / faceonSpreads.length;
  const ratio = dtlMean / faceonMean;
  const gap = dtlMean - faceonMean;

  results.push({ pair: `${jointA}/${jointB}`, dtlMean, faceonMean, ratio, gap });
}

results.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));

console.table(results.map(r => ({
  pair: r.pair,
  dtl: r.dtlMean?.toFixed(4) ?? 'N/A',
  faceOn: r.faceonMean?.toFixed(4) ?? 'N/A',
  ratio: r.ratio ? r.ratio.toFixed(1) + 'x' : 'N/A',
  gap: r.gap?.toFixed(4) ?? 'N/A',
})));
