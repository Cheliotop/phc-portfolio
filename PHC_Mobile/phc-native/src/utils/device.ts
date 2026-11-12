import { Dimensions } from 'react-native';

/** The tablet decision is based on the physical screen's smallest dp width. */
export const isTabletScreen = (width: number, height: number): boolean => Math.min(width, height) >= 600;
export const isTablet = (): boolean => {
  const { width, height } = Dimensions.get('screen');
  return isTabletScreen(width, height);
};
