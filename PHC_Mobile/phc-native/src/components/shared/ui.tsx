import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ViewStyle,
  StyleProp,
  TextStyle,
} from 'react-native';
import { COLORS, SPACING, RADIUS, TYPE, SHADOW, statusTone, toneColor, StatusTone } from '../../theme/phcTheme';

/**
 * PHC shared UI kit (Pass 2). One consistent card / button / badge / header /
 * state set used across operator and admin screens so the app reads as a
 * single professional product instead of many hand-styled screens.
 */

// ---------------------------------------------------------------- PHCCard
export const PHCCard: React.FC<{
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  elevated?: boolean;
}> = ({ children, style, onPress, elevated }) => {
  const content = (
    <View
      style={[
        styles.card,
        elevated && { backgroundColor: COLORS.cardElevated },
        style,
      ]}
    >
      {children}
    </View>
  );
  if (onPress) {
    return (
      <TouchableOpacity activeOpacity={0.85} onPress={onPress}>
        {content}
      </TouchableOpacity>
    );
  }
  return content;
};

// -------------------------------------------------------------- PHCButton
type ButtonVariant = 'primary' | 'secondary' | 'success' | 'danger' | 'ghost';
export const PHCButton: React.FC<{
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}> = ({ title, onPress, variant = 'primary', disabled, loading, fullWidth = true, style, textStyle }) => {
  const bg = {
    primary: COLORS.primary,
    secondary: 'transparent',
    success: COLORS.success,
    danger: COLORS.danger,
    ghost: 'transparent',
  }[variant];

  const fg = variant === 'secondary' ? COLORS.accent : variant === 'ghost' ? COLORS.textSecondary : COLORS.textOnPrimary;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      disabled={disabled || loading}
      style={[
        styles.button,
        { backgroundColor: bg },
        variant === 'secondary' && styles.buttonOutline,
        fullWidth && { alignSelf: 'stretch' },
        (disabled || loading) && styles.buttonDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonText, { color: fg }, textStyle]}>{title}</Text>
      )}
    </TouchableOpacity>
  );
};

// ------------------------------------------------------------- StatusBadge
export const StatusBadge: React.FC<{
  label: string;
  tone?: StatusTone;      // explicit tone, else derived from `label`
  style?: StyleProp<ViewStyle>;
}> = ({ label, tone, style }) => {
  const t = tone || statusTone(label);
  const { fg, bg } = toneColor(t);
  return (
    <View style={[styles.badge, { backgroundColor: bg }, style]}>
      <View style={[styles.badgeDot, { backgroundColor: fg }]} />
      <Text style={[styles.badgeText, { color: fg }]}>{label}</Text>
    </View>
  );
};

// ------------------------------------------------------------- ScreenHeader
export const ScreenHeader: React.FC<{
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}> = ({ title, subtitle, right, style }) => (
  <View style={[styles.screenHeader, style]}>
    <View style={{ flex: 1 }}>
      <Text style={styles.screenTitle}>{title}</Text>
      {!!subtitle && <Text style={styles.screenSubtitle}>{subtitle}</Text>}
    </View>
    {right}
  </View>
);

// ------------------------------------------------------------ SectionHeader
export const SectionHeader: React.FC<{ title: string; right?: React.ReactNode; style?: StyleProp<ViewStyle> }> = ({
  title,
  right,
  style,
}) => (
  <View style={[styles.sectionHeader, style]}>
    <View style={styles.sectionRule} />
    <Text style={styles.sectionTitle}>{title}</Text>
    <View style={styles.sectionSpacer} />
    {right}
  </View>
);

// --------------------------------------------------------------- EmptyState
export const EmptyState: React.FC<{
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}> = ({ title, message, actionLabel, onAction }) => (
  <View style={styles.stateWrap}>
    <View style={styles.stateGlyph}>
      <Text style={styles.stateGlyphText}>PHC</Text>
    </View>
    <Text style={styles.stateTitle}>{title}</Text>
    {!!message && <Text style={styles.stateMessage}>{message}</Text>}
    {!!actionLabel && (
      <PHCButton title={actionLabel} onPress={onAction} variant="secondary" fullWidth={false} style={{ marginTop: SPACING.lg }} />
    )}
  </View>
);

// -------------------------------------------------------------- ErrorBanner
export const ErrorBanner: React.FC<{ message: string; onRetry?: () => void }> = ({ message, onRetry }) => (
  <View style={styles.errorBanner}>
    <Text style={styles.errorText}>{message}</Text>
    {!!onRetry && (
      <TouchableOpacity onPress={onRetry}>
        <Text style={styles.errorRetry}>Reintentar</Text>
      </TouchableOpacity>
    )}
  </View>
);

// -------------------------------------------------------------- LoadingState
export const LoadingState: React.FC<{ message?: string }> = ({ message = 'Cargando…' }) => (
  <View style={styles.stateWrap}>
    <ActivityIndicator size="large" color={COLORS.accent} />
    <Text style={[styles.stateMessage, { marginTop: SPACING.lg }]}>{message}</Text>
  </View>
);

// ---------------------------------------------------------------- MetricCard
export const MetricCard: React.FC<{
  value: React.ReactNode;
  label: string;
  tone?: StatusTone;      // used only for the accent stripe/value color
  style?: StyleProp<ViewStyle>;
}> = ({ value, label, tone, style }) => {
  const accent = tone ? toneColor(tone).fg : COLORS.accent;
  return (
    <View style={[styles.metricCard, style]}>
      <View style={[styles.metricStripe, { backgroundColor: accent }]} />
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.card,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.lg,
    marginBottom: SPACING.lg,
    ...SHADOW.card,
  },
  button: {
    minHeight: 52,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
  },
  buttonOutline: {
    borderWidth: 1.5,
    borderColor: COLORS.accent,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { fontSize: TYPE.body, fontWeight: TYPE.bold },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
  },
  badgeDot: { width: 7, height: 7, borderRadius: RADIUS.sm, marginRight: SPACING.sm },
  badgeText: { fontSize: TYPE.caption, fontWeight: TYPE.bold, letterSpacing: 0.3 },
  screenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.md,
  },
  screenTitle: { color: COLORS.text, fontSize: TYPE.title, fontWeight: TYPE.bold },
  screenSubtitle: { color: COLORS.textSecondary, fontSize: TYPE.label, marginTop: SPACING.xs },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginTop: SPACING.xl, marginBottom: SPACING.md },
  sectionRule: { width: 3, height: 16, borderRadius: RADIUS.sm, backgroundColor: COLORS.accent, marginRight: SPACING.sm },
  sectionTitle: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: TYPE.bold },
  sectionSpacer: { flex: 1 },
  stateWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: SPACING.huge2, paddingHorizontal: SPACING.xl },
  stateGlyph: {
    width: 64, height: 64, borderRadius: RADIUS.lg,
    backgroundColor: COLORS.surfaceVariant,
    borderWidth: 1, borderColor: COLORS.border,
    alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.lg,
  },
  stateGlyphText: { color: COLORS.primaryText, fontWeight: TYPE.bold, letterSpacing: 1.5, fontSize: TYPE.h2 },
  stateTitle: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: TYPE.bold, textAlign: 'center', marginBottom: SPACING.sm },
  stateMessage: { color: COLORS.textSecondary, fontSize: TYPE.label, textAlign: 'center', lineHeight: 21 },
  errorBanner: {
    backgroundColor: COLORS.errorBg,
    borderWidth: 1,
    borderColor: COLORS.danger,
    borderRadius: RADIUS.md,
    padding: SPACING.md,
    marginBottom: SPACING.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  errorText: { color: COLORS.text, fontSize: TYPE.label, flex: 1, marginRight: SPACING.md },
  errorRetry: { color: COLORS.errorText, fontSize: TYPE.label, fontWeight: TYPE.bold },
  metricCard: {
    flex: 1,
    backgroundColor: COLORS.card,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: SPACING.lg,
    paddingHorizontal: SPACING.md,
    overflow: 'hidden',
  },
  metricStripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  metricValue: { color: COLORS.text, fontSize: TYPE.h1, fontWeight: TYPE.bold },
  metricLabel: { color: COLORS.textSecondary, fontSize: TYPE.caption, marginTop: SPACING.xs, fontWeight: TYPE.medium },
});

export default {
  PHCCard,
  PHCButton,
  StatusBadge,
  ScreenHeader,
  SectionHeader,
  EmptyState,
  ErrorBanner,
  LoadingState,
  MetricCard,
};
