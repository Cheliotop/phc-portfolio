/**
 * Tactile feedback.
 *
 * The app had none: zero haptic calls anywhere. This matters more here than in
 * most apps — it is used outdoors, in gloves, next to a running rig, and often
 * one-handed. A buzz is frequently the only confirmation that lands, because
 * the screen is glared out and the rig is louder than any sound the phone can
 * make.
 *
 * Every call is fire-and-forget and swallows its error. Haptics are a nicety;
 * a device without a vibrator, or one where the user has disabled it, must
 * never break the action it was decorating.
 */
import * as Haptics from 'expo-haptics';

/** A tap landed on something interactive. Use sparingly — not on every press. */
export function tapped(): void {
  void Haptics.selectionAsync().catch(() => undefined);
}

/** Something was written, sent or signed. The "it worked" buzz. */
export function committed(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
}

/** The action was refused: validation failed, or the server said no. */
export function rejected(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
}

/** Something needs attention but was not an outright failure. */
export function warned(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
}

/** A destructive control was pressed. Heavier than a selection tick. */
export function destructive(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => undefined);
}
