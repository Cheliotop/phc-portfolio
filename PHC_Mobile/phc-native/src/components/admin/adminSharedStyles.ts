import { StyleSheet } from 'react-native';

import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';

// Page size for the paginated admin lists.
export const ADMIN_LIST_PAGE_SIZE = 20;

/**
 * The style keys used by more than one admin tab.
 *
 * Extracted from AdminDashboard.tsx (A-1) when that file was split into one
 * component per tab. Each component spreads this into its own StyleSheet, which
 * keeps every `styles.x` reference in those components byte-identical to what it
 * was before the split while these keys still have exactly one definition.
 *
 * Run through StyleSheet.create rather than exported as a plain object so the
 * literal types survive: a bare object widens `alignItems: 'center'` to `string`,
 * which is not assignable to FlexAlignType once spread into another sheet.
 */
export const adminSharedStyles = StyleSheet.create({
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
  },
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    padding: SPACING.xl,
  },
  emptyState: {
    alignItems: 'center',
    padding: SPACING.huge,
  },
  emptyStateText: {
    fontSize: TYPE.bodyLg,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  errorIcon: {
    fontSize: TYPE.metric,
    marginBottom: SPACING.lg,
  },
  errorText: {
    color: COLORS.errorText,
    fontSize: TYPE.bodyLg,
    textAlign: 'center',
    marginBottom: SPACING.xxl,
    lineHeight: 24,
  },
  loadingText: {
    color: COLORS.textSecondary,
    fontSize: TYPE.bodyLg,
    marginTop: SPACING.lg,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  retryButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.xxl,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
  },
  retryButtonText: {
    color: COLORS.text,
    fontSize: TYPE.bodyLg,
    fontWeight: 'bold',
  },
  title: {
    fontSize: TYPE.h1,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: SPACING.sm,
  },
});
