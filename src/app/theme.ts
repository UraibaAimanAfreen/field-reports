import { useColorScheme } from 'react-native';
import type { Tone } from '../core/selectors';

export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  line: string;
  text: string;
  textSoft: string;
  textFaint: string;
  accent: string;
  accentText: string;
  good: string;
  goodBg: string;
  warn: string;
  warnBg: string;
  bad: string;
  badBg: string;
  progress: string;
  progressBg: string;
  neutralBg: string;
}

const light: Palette = {
  bg: '#F2F4F6',
  surface: '#FFFFFF',
  surfaceAlt: '#F7F9FA',
  line: '#DFE4E8',
  text: '#131C24',
  textSoft: '#4A5A63',
  textFaint: '#7B8793',
  accent: '#1F6FEB',
  accentText: '#FFFFFF',
  good: '#1F7A4D',
  goodBg: '#E3F3EA',
  warn: '#9A6212',
  warnBg: '#FBEEDA',
  bad: '#AE342C',
  badBg: '#FBE7E5',
  progress: '#1F6FEB',
  progressBg: '#E4EEFC',
  neutralBg: '#ECEFF2',
};

const dark: Palette = {
  bg: '#0F1419',
  surface: '#171E25',
  surfaceAlt: '#1D252D',
  line: '#2A343D',
  text: '#E9EDF0',
  textSoft: '#A8B3BD',
  textFaint: '#78848F',
  accent: '#4D96F8',
  accentText: '#07121F',
  good: '#64D39B',
  goodBg: '#14301F',
  warn: '#E8B268',
  warnBg: '#33250F',
  bad: '#F08B82',
  badBg: '#351916',
  progress: '#4D96F8',
  progressBg: '#132743',
  neutralBg: '#222B33',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 };

/** 44pt is the smallest reliably tappable target; used for every control. */
export const HIT_TARGET = 44;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export function toneColors(palette: Palette, tone: Tone): { fg: string; bg: string } {
  switch (tone) {
    case 'good':
      return { fg: palette.good, bg: palette.goodBg };
    case 'warn':
      return { fg: palette.warn, bg: palette.warnBg };
    case 'bad':
      return { fg: palette.bad, bg: palette.badBg };
    case 'progress':
      return { fg: palette.progress, bg: palette.progressBg };
    default:
      return { fg: palette.textSoft, bg: palette.neutralBg };
  }
}
