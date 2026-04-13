import type { Theme } from '@react-navigation/native';
import { useColorScheme } from 'react-native';

export interface AppTheme {
  colorScheme: 'light' | 'dark';
  colors: {
    background: string;
    surface: string;
    surfaceMuted: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    accentText: string;
    success: string;
    warning: string;
  };
}

export const lightTheme: AppTheme = {
  colorScheme: 'light',
  colors: {
    background: '#F5F7FB',
    surface: '#FFFFFF',
    surfaceMuted: '#EEF2FF',
    border: '#D7DDEA',
    text: '#0F172A',
    textMuted: '#52607A',
    accent: '#5B3DF5',
    accentText: '#FFFFFF',
    success: '#0B8F5C',
    warning: '#B66A14',
  },
};

export const darkTheme: AppTheme = {
  colorScheme: 'dark',
  colors: {
    background: '#0B1020',
    surface: '#11182A',
    surfaceMuted: '#172038',
    border: '#22304A',
    text: '#F7FAFC',
    textMuted: '#94A3B8',
    accent: '#8B7CFF',
    accentText: '#0B1020',
    success: '#3DD598',
    warning: '#FFB648',
  },
};

export function useAppTheme(): AppTheme {
  const colorScheme = useColorScheme();
  return colorScheme === 'dark' ? darkTheme : lightTheme;
}

export function createNavigationTheme(theme: AppTheme): Theme {
  return {
    dark: theme.colorScheme === 'dark',
    colors: {
      primary: theme.colors.accent,
      background: theme.colors.background,
      card: theme.colors.surface,
      text: theme.colors.text,
      border: theme.colors.border,
      notification: theme.colors.warning,
    },
    fonts: {
      regular: {
        fontFamily: 'System',
        fontWeight: '400',
      },
      medium: {
        fontFamily: 'System',
        fontWeight: '500',
      },
      bold: {
        fontFamily: 'System',
        fontWeight: '700',
      },
      heavy: {
        fontFamily: 'System',
        fontWeight: '800',
      },
    },
  };
}
