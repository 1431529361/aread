import type { TextStyle, ViewStyle } from 'react-native';

export const colors = {
  bg: '#f7f3ec',
  card: '#fffdf9',
  cardAlt: '#f1ebe1',
  text: '#241f1a',
  textMuted: '#7b7167',
  textFaint: '#a49a8e',
  border: '#e4dbcf',
  primary: '#a84f2b',
  primaryPressed: '#8e3f20',
  primarySoft: '#f3e2d8',
  success: '#3f7a52',
  successSoft: '#e3efe5',
  warn: '#a06a1f',
  warnSoft: '#f8ecd7',
  danger: '#a83a32',
  dangerSoft: '#f8e3e0',
  info: '#356b8c',
  infoSoft: '#e2edf4',
  overlay: 'rgba(24, 20, 16, 0.45)',
  white: '#ffffff',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
};

export const type = {
  title: { fontSize: 26, fontWeight: '700', color: colors.text } as TextStyle,
  h1: { fontSize: 20, fontWeight: '700', color: colors.text } as TextStyle,
  h2: { fontSize: 16, fontWeight: '600', color: colors.text } as TextStyle,
  body: { fontSize: 15, lineHeight: 22, color: colors.text } as TextStyle,
  small: { fontSize: 13, lineHeight: 18, color: colors.textMuted } as TextStyle,
  tiny: { fontSize: 11, lineHeight: 15, color: colors.textFaint } as TextStyle,
};

export const shadow: ViewStyle = {
  shadowColor: '#3a2c1e',
  shadowOpacity: 0.08,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 4 },
  elevation: 2,
};
