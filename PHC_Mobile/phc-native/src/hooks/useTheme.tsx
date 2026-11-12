import React, { createContext, useContext } from 'react';
import { COLORS, SPACING, RADIUS, TYPE, SHADOW, STATUS } from '../theme/phcTheme';

/**
 * PHC theme (Pass 2). The app now ships a single, consistent dark-navy brand
 * theme — the previous Material grey light/dark toggle was removed because
 * light mode was broken across most screens and produced an inconsistent,
 * unprofessional result. `toggleTheme`/`setTheme` are kept as no-ops so any
 * remaining callers compile, but the theme toggle UI has been removed.
 *
 * All tokens come from src/theme/phcTheme.ts. The `colors` keys below are a
 * superset of what existing screens reference, so nothing that reads
 * `theme.colors.*` breaks.
 */

export type ThemeMode = 'dark';

const phcColors = {
  ...COLORS,
  // legacy keys kept for back-compat with older screens
  secondary: COLORS.primary,
};

export type ThemeColors = typeof phcColors;

export interface Theme {
  mode: ThemeMode;
  colors: ThemeColors;
  spacing: typeof SPACING;
  radius: typeof RADIUS;
  type: typeof TYPE;
  shadow: typeof SHADOW;
  status: typeof STATUS;
  isDark: boolean;
}

const phcTheme: Theme = {
  mode: 'dark',
  colors: phcColors,
  spacing: SPACING,
  radius: RADIUS,
  type: TYPE,
  shadow: SHADOW,
  status: STATUS,
  isDark: true,
};

interface ThemeContextValue {
  theme: Theme;
  setTheme: (mode: ThemeMode) => void;
  toggleTheme: () => void;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: phcTheme,
  setTheme: () => {},
  toggleTheme: () => {},
  isDark: true,
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const value: ThemeContextValue = {
    theme: phcTheme,
    setTheme: () => {},
    toggleTheme: () => {},
    isDark: true,
  };
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);

// Back-compat exports (some modules import these names).
export const themes = { dark: phcTheme } as const;
export const darkColors = phcColors;
export const lightColors = phcColors;
