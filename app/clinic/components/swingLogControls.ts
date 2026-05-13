import type {
  BallContact,
  BallDirection,
  EffortLevel,
} from '@/packages/domain/clinic/enums';

export const BALL_CONTACT_OPTIONS: readonly BallContact[] = [
  'solid',
  'thin',
  'fat',
  'sky',
  'shank',
  'whiff',
  'unknown',
];

export const BALL_DIRECTION_OPTIONS: readonly BallDirection[] = [
  'pull',
  'pull-fade',
  'pull-hook',
  'straight',
  'fade',
  'slice',
  'draw',
  'hook',
  'push',
  'push-draw',
  'push-fade',
  'unknown',
];

export interface KidSimpleOutcome {
  label: string;
  direction: BallDirection;
  contact: BallContact;
}

export const KID_SIMPLE_OUTCOMES: readonly KidSimpleOutcome[] = [
  { label: 'straight', direction: 'straight', contact: 'solid' },
  { label: 'left',     direction: 'left',     contact: 'solid' },
  { label: 'right',    direction: 'right',    contact: 'solid' },
  { label: 'topped',   direction: 'straight', contact: 'topped' },
  { label: 'missed',   direction: 'unknown',  contact: 'whiff' },
];

export const EFFORT_OPTIONS: readonly EffortLevel[] = ['low', 'medium', 'high'];

export function clampWords(value: string, maxWords = 5): string {
  const tokens = value.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length <= maxWords) {
    return value.replace(/^\s+/, '');
  }
  return tokens.slice(0, maxWords).join(' ');
}
