/**
 * Motion.
 *
 * The app had four `Animated` calls in total and no LayoutAnimation, so
 * nothing ever moved: lists jumped, steps snapped, rows appeared and vanished
 * with no indication of where they came from. That reads as cheap even when
 * every individual screen is correct, because the eye is given nothing to
 * follow.
 *
 * LayoutAnimation is used rather than Reanimated on purpose. It is already in
 * React Native, needs no new native dependency before a handoff, and animates
 * the layout the components already produce — so a screen does not have to be
 * rewritten to move. On Android it is off unless explicitly enabled, which is
 * almost certainly why this app never had it.
 */
import { LayoutAnimation, Platform, UIManager } from 'react-native';

let enabled = false;

/** Call once at startup. Safe to call more than once. */
export function enableLayoutAnimation(): void {
  if (enabled || Platform.OS !== 'android') {
    enabled = true;
    return;
  }
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
  enabled = true;
}

/**
 * Animate whatever the next render changes about the layout.
 *
 * Call immediately before the state update that changes it, not after. Keep it
 * to changes the user caused — animating a background refresh makes the screen
 * twitch on its own, which is worse than not animating at all.
 */
export function animateNextLayout(kind: 'gentle' | 'quick' = 'gentle'): void {
  if (!enabled) enableLayoutAnimation();
  LayoutAnimation.configureNext(
    kind === 'quick'
      ? {
          duration: 160,
          update: { type: LayoutAnimation.Types.easeInEaseOut },
        }
      : {
          duration: 240,
          create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
          update: { type: LayoutAnimation.Types.easeInEaseOut },
          delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
        },
  );
}
