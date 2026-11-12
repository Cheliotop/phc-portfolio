/**
 * PHC design tokens — single source of truth for the app's visual system.
 * Pass 2 brand redesign. Derived from the PHC website (Perforaciones
 * Hidrogeológicas Chaco): deep-navy industrial identity, brand blue,
 * white lettering. Dark-navy-only for now (light mode was broken and is
 * intentionally not shipped this pass — see useTheme.tsx).
 *
 * Import these tokens directly in StyleSheet.create() blocks, or read the
 * equivalent `theme.colors.*` keys via useTheme() (kept for back-compat).
 */

// --- Brand palette (from PHC Inicio reference) ---
//
// Surface ramp, revised 2026-07-31. Every surface pair used to sit under
// 1.5:1 — card against background was 1.17:1 and input against card was
// 1.07:1 — so cards did not read as cards and inputs did not read as inputs.
// The whole UI was one flat navy field, which is why it felt dark and
// unstructured rather than merely dark.
//
// The fill alone cannot fix it. Background to brandBlue is only 2.35:1 of
// total headroom, so splitting that across background -> card -> button
// leaves ~1.53:1 per step at best, and pushing cards any lighter makes the
// action buttons disappear into them. The fill therefore lifts modestly and
// the border carries the boundary, which is the usual answer for a dark theme
// with little luminance to spend.
//
// Hue is held at 218deg throughout; saturation drops as lightness rises so
// that saturated blue stays reserved for actions.
export const PALETTE = {
  navy: '#0B1D3C',        // deep navy base
  navyDark: '#071328',    // darker navy (headers/app bar/status bar)
  navySurface: '#1F365D', // cards / surfaces on navy  — 1.39:1 vs navy (was 1.17)
  navyInput: '#122340',   // inputs / inner wells      — 1.30:1 vs card (was 1.07)
  navyElevated: '#2A4572',// hover/pressed/selected    — 1.26:1 vs card (was 1.14)
  brandBlue: '#1E56A8',   // primary action / brand    — 1.69:1 vs card, stays distinct
  brandBlueDark: '#17458B',
  accentBlue: '#4E86D8',  // accents, tints, progress, active indicator
  white: '#FFFFFF',
  lightSurface: '#F4F7FB',
  lightSurface2: '#E9EFF7',
  borderLightHex: '#DAE2EE',
};

// --- Semantic status palette (meaningful color ONLY) ---
// blue = active/in-progress · green = completed/approved/success
// amber = pending/paused/low/warning · red = rejected/critical/error
// gray = inactive/archived/neutral
export const STATUS = {
  active: '#4E86D8',
  activeBg: 'rgba(78,134,216,0.16)',
  success: '#2E9E6B',
  successBg: 'rgba(46,158,107,0.16)',
  warning: '#D08A1E',
  warningBg: 'rgba(208,138,30,0.16)',
  danger: '#D0483C',
  dangerBg: 'rgba(208,72,60,0.16)',
  neutral: '#7C8BA3',
  neutralBg: 'rgba(124,139,163,0.16)',
};

export const COLORS = {
  // surfaces
  background: PALETTE.navy,
  backgroundDark: PALETTE.navyDark,
  surface: PALETTE.navySurface,
  surfaceVariant: PALETTE.navyInput,
  card: PALETTE.navySurface,
  cardElevated: PALETTE.navyElevated,
  input: PALETTE.navyInput,
  appBar: PALETTE.navyDark,

  // brand / actions
  primary: PALETTE.brandBlue,
  primaryDark: PALETTE.brandBlueDark,
  accent: PALETTE.accentBlue,

  // Brand blue used as TEXT on a dark surface.
  //
  // `primary` and `accent` are fills. As text they were never readable —
  // primary scored 2.02:1 on a card and accent 3.91:1, both under the 4.5:1
  // floor, and 23 places across the app used them for text anyway. This is the
  // same gap the status colours had: a solid tone tuned for a button is not a
  // text tone. Same brand hue at 216deg, lightened until it clears AA on all
  // four surfaces (worst case 4.51:1 on elevated, 5.67:1 on a card).
  primaryText: '#8FB4EB',

  // text
  // Ratios below are worst case across all four surfaces the app renders text
  // on: navy, navySurface, navyElevated and navyInput. Raised 2026-07-31 for
  // legibility on old and damaged screens in daylight; the top two tiers now
  // clear AAA (7:1) rather than sitting just over the AA floor.
  text: PALETTE.white,             // 9.58  AAA
  textSecondary: '#D6DDE9',        // 7.01  AAA  (was #AFC0DA, 6.84)
  textMuted: '#BBC5D7',            // 5.51  AA   (was #8E9DB6, 4.60)
  placeholder: '#A9B5C8',          // 4.62  AA   (was #8695AE, 4.17)
  textOnPrimary: PALETTE.white,

  // lines
  // The border does the work the fill cannot afford: at 2.21:1 against a card
  // it is a genuinely visible edge rather than the old 1.37:1 suggestion of
  // one. borderStrong hits the 3:1 WCAG threshold for a boundary that is the
  // only means of identifying a control, so use it for focus and for inputs
  // that sit directly on the page.
  border: '#4B6A9F',               // 2.21:1 vs card (was #20406B, 1.37)
  borderLight: '#33507F',          // 1.65:1 vs card — subdued dividers
  borderStrong: '#6480AF',         // 3.01:1 vs card — focus rings, bare inputs

  // status (semantic)
  success: STATUS.success,
  warning: STATUS.warning,
  error: STATUS.danger,
  danger: STATUS.danger,
  info: PALETTE.accentBlue,
  neutral: STATUS.neutral,
  successBg: STATUS.successBg,
  warningBg: STATUS.warningBg,
  errorBg: STATUS.dangerBg,

  // Status colours used as TEXT on a dark surface.
  // The solid STATUS values are tuned for fills and badges; as text on navy
  // they fail AA (danger 3.19:1, success 4.25:1 on navySurface). These lighter
  // tints are the text-safe counterparts and clear AA everywhere
  // (error 7.07, success 8.97, warning 7.90 on navySurface).
  errorText: '#FF9B92',
  successText: '#7CE0AE',
  warningText: '#F1B656',

  // Scrims behind modals. Translucent black rather than a navy tint, so the
  // dimmed layer reads as "behind" instead of as another surface in the ramp.
  // `strong` is for a full-screen photo, where any leaking UI competes with the
  // image the viewer is trying to judge.
  backdrop: 'rgba(0,0,0,0.6)',
  backdropStrong: 'rgba(0,0,0,0.9)',
};

// 4px base grid. `none` exists so a deliberate zero reads differently from an
// unset value. The steps above xxxl were already in use for screen gutters and
// scroll-clearance padding; they are named here rather than left as literals.
export const SPACING = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
  huge2: 48,
  huge3: 56,
  huge4: 64,
  huge5: 80,
};

// Shared content measure for operator/admin screens and dialogs. At phone
// widths the max has no effect; tablet content stays readable when centered.
export const CONTENT_MAX_WIDTH = 880;

export const RADIUS = {
  sm: 6,
  md: 8,
  lg: 12,
  pill: 999,
};

export const TYPE = {
  // sizes
  metricLg: 64,   // full-screen numeric readouts
  metric: 48,     // dashboard metric figures
  display: 34,
  h1: 24,
  title: 22,
  h2: 18,
  bodyLg: 16,     // the most-used body size in the app
  body: 15,
  label: 14,
  caption: 12,
  micro: 11,
  // weights
  //
  // `regular` is 500, not 400. On Android at 12-16px a 400 stroke thins out
  // badly on low-density panels, behind glare, and behind a cracked digitiser
  // — which is the population this app actually runs on. 500 costs nothing and
  // holds the stroke together. The rest of the scale is unchanged so the
  // relative hierarchy still reads.
  bold: '700' as const,
  semibold: '600' as const,
  medium: '500' as const,
  regular: '500' as const,
  // tracking for the uppercase PHC wordmark
  wordmarkTracking: 2,
};

export const SHADOW = {
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
  header: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
};

/**
 * Map a domain status string (project/pedido/stock/operator, ES or EN) to a
 * semantic status color set. Keeps color meaning consistent app-wide.
 */
export type StatusTone = 'active' | 'success' | 'warning' | 'danger' | 'neutral';

export const statusTone = (raw?: string): StatusTone => {
  const s = (raw || '').toString().trim().toLowerCase();
  switch (s) {
    case 'en progreso':
    case 'active':
    case 'activo':
    case 'in_progress':
    case 'good':
    case 'buen stock':
      return s === 'good' || s === 'buen stock' ? 'success' : 'active';
    case 'completado':
    case 'completed':
    case 'aprobado':
    case 'approved':
    case 'signed':
    case 'firmado':
      return 'success';
    case 'pendiente':
    case 'pending':
    case 'pausado':
    case 'paused':
    case 'low':
    case 'stock bajo':
    case 'submitted':
    case 'enviado':
      return 'warning';
    case 'rechazado':
    case 'rejected':
    case 'critical':
    case 'stock crítico':
    case 'stock critico':
    case 'error':
      return 'danger';
    case 'inactive':
    case 'inactivo':
    case 'archived':
      return 'neutral';
    default:
      return 'active';
  }
};

export const toneColor = (tone: StatusTone) => {
  switch (tone) {
    case 'success': return { fg: STATUS.success, bg: STATUS.successBg };
    case 'warning': return { fg: STATUS.warning, bg: STATUS.warningBg };
    case 'danger': return { fg: STATUS.danger, bg: STATUS.dangerBg };
    case 'neutral': return { fg: STATUS.neutral, bg: STATUS.neutralBg };
    case 'active':
    default: return { fg: STATUS.active, bg: STATUS.activeBg };
  }
};

export const phcTheme = {
  colors: COLORS,
  spacing: SPACING,
  radius: RADIUS,
  type: TYPE,
  shadow: SHADOW,
  status: STATUS,
  isDark: true,
  mode: 'dark' as const,
};

export type PHCTheme = typeof phcTheme;
