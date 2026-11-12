import React from 'react';
import { View, Text, Image, StyleSheet, ImageStyle, StyleProp } from 'react-native';
import { COLORS, TYPE, SPACING } from '../../theme/phcTheme';

// Real PHC logo, copied into assets in Pass 2. If the bundled asset ever
// fails to resolve, we fall back to the PHC wordmark (never a blank space).
// eslint-disable-next-line @typescript-eslint/no-var-requires
let logoSource: number | null = null;
try {
  logoSource = require('../../../assets/phc-logo.png');
} catch {
  logoSource = null;
}

interface PHCLogoProps {
  height?: number;
  showWordmark?: boolean;   // show "PHC" + tagline text next to/under the mark
  variant?: 'stacked' | 'inline';
  style?: StyleProp<ImageStyle>;
  tint?: 'light' | 'brand';
}

/**
 * PHC brand mark. Uses the real logo image when available, otherwise a clean
 * typographic fallback. Safe to drop into headers, login, and cards.
 */
export const PHCLogo: React.FC<PHCLogoProps> = ({
  height = 40,
  showWordmark = false,
  variant = 'inline',
  style,
  tint = 'light',
}) => {
  const markColor = tint === 'brand' ? COLORS.accent : COLORS.text;

  if (logoSource) {
    return (
      <Image
        source={logoSource}
        resizeMode="contain"
        style={[{ height, width: height * 2.85 }, style]}
        accessibilityLabel="PHC - Perforaciones Hidrogeológicas Chaco"
      />
    );
  }

  // Typographic fallback
  return (
    <View style={variant === 'stacked' ? styles.stacked : styles.inline}>
      <Text style={[styles.wordmark, { color: markColor, fontSize: height * 0.6 }]}>PHC</Text>
      {showWordmark && (
        <Text style={styles.tagline}>PERFORACIONES HIDROGEOLÓGICAS CHACO</Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', alignItems: 'center' },
  stacked: { alignItems: 'center' },
  wordmark: {
    fontWeight: TYPE.bold,
    letterSpacing: TYPE.wordmarkTracking,
  },
  tagline: {
    color: COLORS.textSecondary,
    fontSize: TYPE.micro,
    letterSpacing: 1.5,
    marginTop: SPACING.xs,
    fontWeight: TYPE.semibold,
  },
});

export default PHCLogo;
