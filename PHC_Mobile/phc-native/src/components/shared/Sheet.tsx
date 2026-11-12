/**
 * The app's own dialog.
 *
 * There were 135 `Alert.alert` calls and not one designed sheet, so every
 * confirmation, error and menu in the product was a stock Android grey box —
 * the OS's typography, the OS's buttons, none of it PHC's. That is the single
 * largest reason the app reads as a tool rather than a product.
 *
 * Deliberately mirrors `Alert.alert(title, message, buttons)` so the 135 call
 * sites migrate mechanically instead of being rewritten by hand, and so a
 * developer reaching for a dialog writes the same shape they already know.
 *
 * Differences that are on purpose:
 *   - anchored to the bottom, because the app is used one-handed in gloves and
 *     the top of a phone is the hardest place for a thumb to reach
 *   - actions are full-width and at least 48dp, for the same reason
 *   - it animates in, because nothing in this app moved before
 *   - it buzzes, matching the severity of what it is announcing
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { COLORS, CONTENT_MAX_WIDTH, RADIUS, SHADOW, SPACING, TYPE } from '../../theme/phcTheme';
import { committed, rejected, tapped, warned } from '../../utils/feedback';

export type SheetButtonStyle = 'default' | 'cancel' | 'destructive';

export interface SheetButton {
  text?: string;
  style?: SheetButtonStyle;
  /**
   * Returns `unknown` rather than `void` because Alert's own type is that
   * permissive and existing handlers rely on it — one returns Promise<boolean>.
   * Narrowing here would have forced edits at call sites for no benefit.
   */
  onPress?: () => unknown;
}

export type SheetTone = 'info' | 'success' | 'warning' | 'error';

interface SheetRequest {
  title: string;
  message?: string;
  buttons?: SheetButton[];
  tone: SheetTone;
}

type Listener = (request: SheetRequest | null) => void;

let listener: Listener | null = null;
let queue: SheetRequest[] = [];

/**
 * Guess severity from the title so 135 migrated call sites get sensible colour
 * and haptics without each one being annotated. `showSheet` takes an explicit
 * tone when the guess is not good enough.
 */
function inferTone(title: string, buttons?: SheetButton[]): SheetTone {
  if (buttons?.some((button) => button.style === 'destructive')) return 'warning';
  const lower = title.toLowerCase();
  if (/error|falló|no se pudo|denegado|bloquead|inválid/.test(lower)) return 'error';
  // Seen on device: "Cierre asignado" came out informational rather than
  // successful, because the list only covered the verbs already in use. Any
  // Spanish past participle announcing a completed action belongs here.
  if (/listo|éxito|guardad|enviad|registrad|actualizad|confirmad|asignad|cread|firmad|complet|aprobad|recibid/.test(lower)) return 'success';
  if (/atención|advertencia|falta|requerid|pendiente/.test(lower)) return 'warning';
  return 'info';
}

/** Drop-in replacement for `Alert.alert`. */
export function showSheet(
  title: string,
  message?: string,
  buttons?: SheetButton[],
  tone?: SheetTone,
): void {
  const request: SheetRequest = { title, message, buttons, tone: tone ?? inferTone(title, buttons) };
  if (listener) listener(request);
  else queue.push(request);
}

const TONE_COLOR: Record<SheetTone, string> = {
  info: COLORS.primaryText,
  success: COLORS.successText,
  warning: COLORS.warningText,
  error: COLORS.errorText,
};

const TONE_HAPTIC: Record<SheetTone, () => void> = {
  info: tapped,
  success: committed,
  warning: warned,
  error: rejected,
};

/**
 * Mounted once, near the root. Anything can call `showSheet` from anywhere,
 * including non-React code such as the api layer, which is why this is an
 * imperative host rather than a hook.
 */
export const SheetHost = () => {
  const [request, setRequest] = useState<SheetRequest | null>(null);
  const slide = useRef(new Animated.Value(0)).current;
  // The sheet draws under Android's navigation bar, so without this the last action,
  // usually the one that does the thing, sat half behind it.
  const bottomInset = useContext(SafeAreaInsetsContext)?.bottom ?? 0;

  useEffect(() => {
    listener = setRequest;
    // Anything raised before the host mounted still has to be shown.
    if (queue.length) {
      const pending = queue;
      queue = [];
      pending.forEach((entry) => setRequest(entry));
    }
    return () => {
      listener = null;
    };
  }, []);

  useEffect(() => {
    if (!request) return;
    TONE_HAPTIC[request.tone]();
    slide.setValue(0);
    Animated.timing(slide, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [request, slide]);

  const dismiss = useCallback(() => setRequest(null), []);

  // A sheet with no cancel action is a decision that has to be made, so the
  // hardware back button must not silently discard it.
  const dismissable = !request?.buttons?.length
    || request.buttons.some((button) => button.style === 'cancel');

  useEffect(() => {
    if (!request) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (dismissable) dismiss();
      return true;
    });
    return () => subscription.remove();
  }, [request, dismissable, dismiss]);

  if (!request) return null;

  // A notice with nothing to decide gets a filled action, not an outlined one.
  // Outlined reads as "the lesser of two choices", and when it is the only
  // choice that is just a button asking to be looked past.
  const buttons: SheetButton[] = request.buttons?.length
    ? request.buttons
    : [{ text: 'Entendido', style: 'default' }];

  const press = (button: SheetButton) => {
    dismiss();
    void button.onPress?.();
  };

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [320, 0] });

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => dismissable && dismiss()}>
      <View style={styles.backdrop}>
        <Pressable
          style={styles.backdropTouchable}
          onPress={() => dismissable && dismiss()}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
        <Animated.View
          testID="sheet-panel"
          style={[styles.sheet, { paddingBottom: SPACING.xxl + bottomInset, transform: [{ translateY }] }]}
        >
          <View style={styles.grabber} />
          <View style={[styles.toneBar, { backgroundColor: TONE_COLOR[request.tone] }]} />
          <ScrollView
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.body}
          >
            <Text style={styles.title} accessibilityRole="header">{request.title}</Text>
            {request.message ? <Text style={styles.message}>{request.message}</Text> : null}
          </ScrollView>
          <View style={styles.actions}>
            {buttons.map((button, index) => (
              <Pressable
                key={`${button.text ?? 'accion'}-${index}`}
                testID={`sheet-action-${index}`}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.action,
                  button.style === 'cancel' && styles.actionCancel,
                  button.style === 'destructive' && styles.actionDestructive,
                  pressed && styles.actionPressed,
                ]}
                onPress={() => press(button)}
              >
                <Text style={[
                  styles.actionText,
                  button.style === 'cancel' && styles.actionTextCancel,
                  button.style === 'destructive' && styles.actionTextDestructive,
                ]}>
                  {button.text ?? 'Aceptar'}
                </Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  backdropTouchable: { ...StyleSheet.absoluteFillObject, backgroundColor: COLORS.backdrop },
  sheet: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderTopLeftRadius: RADIUS.lg,
    borderTopRightRadius: RADIUS.lg,
    borderTopWidth: 1,
    maxHeight: '80%',
    paddingTop: SPACING.md,
    ...SHADOW.card,
  },
  grabber: {
    alignSelf: 'center', backgroundColor: COLORS.border, borderRadius: RADIUS.pill,
    height: 4, marginBottom: SPACING.md, width: 44,
  },
  toneBar: { height: 3, marginBottom: SPACING.lg },
  body: { paddingHorizontal: SPACING.xl },
  title: { color: COLORS.text, fontSize: TYPE.title, fontWeight: TYPE.bold },
  message: { color: COLORS.textSecondary, fontSize: TYPE.bodyLg, lineHeight: 24, marginTop: SPACING.sm },
  actions: { gap: SPACING.sm, paddingHorizontal: SPACING.xl, paddingTop: SPACING.xl },
  // 52dp: comfortably over the 48dp minimum, for a gloved thumb.
  action: {
    alignItems: 'center', backgroundColor: COLORS.primary, borderRadius: RADIUS.md,
    justifyContent: 'center', minHeight: 52, paddingHorizontal: SPACING.lg,
  },
  actionCancel: { backgroundColor: 'transparent', borderColor: COLORS.border, borderWidth: 1 },
  actionDestructive: { backgroundColor: COLORS.danger },
  actionPressed: { opacity: 0.75 },
  actionText: { color: COLORS.textOnPrimary, fontSize: TYPE.bodyLg, fontWeight: TYPE.bold },
  actionTextCancel: { color: COLORS.textSecondary },
  actionTextDestructive: { color: COLORS.text },
});
