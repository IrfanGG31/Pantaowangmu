import { haptic } from './telegram.js';

export type HapticStyle =
  | 'light'
  | 'medium'
  | 'heavy'
  | 'rigid'
  | 'soft'
  | 'error'
  | 'success'
  | 'warning'
  | 'selection';

/**
 * Triggers Telegram native haptic feedback.
 * @param style Feedback intensity or notification type
 */
export function triggerHaptic(style: HapticStyle = 'light') {
  if (style === 'selection') {
    haptic('selection');
  } else if (['error', 'success', 'warning'].includes(style)) {
    haptic(style as 'error' | 'success' | 'warning');
  } else {
    haptic('impact'); // telegram.ts uses a fixed 'medium' impact
  }
}

export default triggerHaptic;
