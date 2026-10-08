import type { Theme } from '../core/theme';
import { parseColor } from '../roofs/colors';

/** Fog colour per theme (sRGB). */
export const FOG_COLORS: Record<Theme, string> = {
  day: '#dfe5ea',
  dawn: '#efd4c4',
  dusk: '#b7aec8',
  night: '#5d6888',
};

/** The theme's fog colour, or a parseable CSS override. */
export function fogColor(theme: Theme, override?: string): string {
  return parseColor(override) ?? FOG_COLORS[theme];
}
