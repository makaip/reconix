// Model colors. "clay" is a light matte render like a product mockup; "dark" follows the app's
// real dark theme. Switch with ?palette=dark for comparison; clay is the default.

export interface Palette {
  window: string
  surfaceLo: string
  surfaceHi: string
  inset: string
  page: string
  pageCard: string
  input: string
  ink: string
  onInk: string
  text: string
  textMuted: string
  textFaint: string
  pageText: string
  pageFaint: string
  bar: string
  pageBar: string
  line: string
  accent: string
  onAccent: string
  accentSoft: string
  onAccentSoft: string
  codeBg: string
  syntax: string[]
  critical: string
  high: string
  medium: string
  success: string
}

export const CLAY: Palette = {
  window: '#c6c6c9',
  surfaceLo: '#bcbcc0',
  surfaceHi: '#d3d3d6',
  inset: '#b1b1b6',
  page: '#e2e2e4',
  pageCard: '#ececed',
  input: '#d6d6d9',
  ink: '#3a3a40',
  onInk: '#e6e6e8',
  text: '#45454c',
  textMuted: '#65656c',
  textFaint: '#86868d',
  pageText: '#3a3a40',
  pageFaint: '#8a8a91',
  bar: '#a3a3a9',
  pageBar: '#c4c4c8',
  line: '#a9a9ae',
  accent: '#4a8fe6',
  onAccent: '#f4f8fd',
  accentSoft: '#b4cdee',
  onAccentSoft: '#29507f',
  codeBg: '#3a3a40',
  syntax: ['#8fb8e0', '#e0a37a', '#9fcfc6', '#bdbdc2'],
  critical: '#d25a50',
  high: '#de8a4a',
  medium: '#d6aa4a',
  success: '#5aaa82'
}

export const DARK: Palette = {
  window: '#2a2a2e',
  surfaceLo: '#212125',
  surfaceHi: '#343439',
  inset: '#1b1b1e',
  page: '#d8d8db',
  pageCard: '#e6e6e8',
  input: '#cdcdd1',
  ink: '#2a2a2e',
  onInk: '#e6e6e8',
  text: '#c9c9ce',
  textMuted: '#9a9aa1',
  textFaint: '#76767d',
  pageText: '#2f2f34',
  pageFaint: '#86868d',
  bar: '#4a4a50',
  pageBar: '#bdbdc2',
  line: '#3a3a3f',
  accent: '#4a9eff',
  onAccent: '#f4f8fd',
  accentSoft: '#253a55',
  onAccentSoft: '#a9cdf7',
  codeBg: '#151517',
  syntax: ['#6cb6df', '#e8946a', '#6cc9d2', '#8a8a91'],
  critical: '#d64545',
  high: '#e0803a',
  medium: '#e0a030',
  success: '#4fb286'
}

export function pickPalette(): Palette {
  if (typeof window === 'undefined') return CLAY
  return new URLSearchParams(window.location.search).get('palette') === 'dark' ? DARK : CLAY
}
