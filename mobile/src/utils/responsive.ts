import { Dimensions, PixelRatio, ScaledSize } from 'react-native';
import { useWindowDimensions } from 'react-native';

/**
 * Responsive scaling helpers.
 *
 * All design values in the app were authored against a ~375pt-wide reference
 * device (iPhone X / 11 / 12 class). On narrower phones (e.g. iPhone 12 mini,
 * Galaxy S23 ~ 360pt) fixed pixel sizes overflow and look oversized, while on
 * larger phones they look slightly small. These helpers scale sizes relative to
 * the actual screen width/height with sensible clamping so UI never grows or
 * shrinks too aggressively.
 */

// Reference dimensions (portrait) the design was built against.
const BASE_WIDTH = 375;
const BASE_HEIGHT = 812;

// Clamp factors so scaling stays within a comfortable range.
const MIN_SCALE = 0.85;
const MAX_SCALE = 1.15;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getWindow(): ScaledSize {
  return Dimensions.get('window');
}

/**
 * Scale a size based on screen width relative to the base width.
 * Result is clamped to avoid extreme scaling on very small/large devices.
 */
export function scale(size: number): number {
  const { width } = getWindow();
  const factor = clamp(width / BASE_WIDTH, MIN_SCALE, MAX_SCALE);
  return Math.round(PixelRatio.roundToNearestPixel(size * factor));
}

/**
 * Scale a size based on screen height relative to the base height.
 * Useful for vertical spacing / heights.
 */
export function verticalScale(size: number): number {
  const { height } = getWindow();
  const factor = clamp(height / BASE_HEIGHT, MIN_SCALE, MAX_SCALE);
  return Math.round(PixelRatio.roundToNearestPixel(size * factor));
}

/**
 * Moderate scale: scales toward the width factor but only by `factor` amount
 * (default 0.5) so the change is gentler than `scale`. Ideal for font sizes and
 * paddings that should adapt but not dramatically.
 */
export function moderateScale(size: number, factor = 0.5): number {
  return Math.round(size + (scale(size) - size) * factor);
}

// Device size breakpoints (based on the shorter side / width in portrait).
const SMALL_DEVICE_WIDTH = 360; // Galaxy S23, iPhone 12/13 mini class and below
const LARGE_DEVICE_WIDTH = 414; // Plus / Max / large Android phones
const TABLET_WIDTH = 600;

export function isSmallDevice(width?: number): boolean {
  const w = width ?? getWindow().width;
  return w <= SMALL_DEVICE_WIDTH;
}

export function isLargeDevice(width?: number): boolean {
  const w = width ?? getWindow().width;
  return w >= LARGE_DEVICE_WIDTH;
}

export function isTablet(width?: number): boolean {
  const w = width ?? getWindow().width;
  return w >= TABLET_WIDTH;
}

export type Responsive = {
  width: number;
  height: number;
  isSmall: boolean;
  isLarge: boolean;
  isTablet: boolean;
  isLandscape: boolean;
  scale: (size: number) => number;
  verticalScale: (size: number) => number;
  moderateScale: (size: number, factor?: number) => number;
};

/**
 * React hook that reacts to dimension changes (rotation, foldables, split view).
 * Prefer this inside components so layout updates live.
 */
export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();
  const widthFactor = clamp(width / BASE_WIDTH, MIN_SCALE, MAX_SCALE);
  const heightFactor = clamp(height / BASE_HEIGHT, MIN_SCALE, MAX_SCALE);

  const scaleFn = (size: number) =>
    Math.round(PixelRatio.roundToNearestPixel(size * widthFactor));
  const verticalScaleFn = (size: number) =>
    Math.round(PixelRatio.roundToNearestPixel(size * heightFactor));
  const moderateScaleFn = (size: number, factor = 0.5) =>
    Math.round(size + (scaleFn(size) - size) * factor);

  return {
    width,
    height,
    isSmall: width <= SMALL_DEVICE_WIDTH,
    isLarge: width >= LARGE_DEVICE_WIDTH,
    isTablet: width >= TABLET_WIDTH,
    isLandscape: width > height,
    scale: scaleFn,
    verticalScale: verticalScaleFn,
    moderateScale: moderateScaleFn,
  };
}