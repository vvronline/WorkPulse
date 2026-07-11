import { Switch as RNSwitch } from "react-native";
import { useTheme } from "../../theme/ThemeProvider";

/**
 * Native-backed toggle powered by `@expo/ui`'s universal `Switch` (SwiftUI
 * `Toggle` on iOS, Material 3 `Switch` on Android via Jetpack Compose), wrapped
 * in the required `Host` bridge. Falls back to React Native's core `<Switch>`
 * when `@expo/ui` is unavailable at runtime.
 *
 * Drop-in for the RN `<Switch>` call sites: same `value` / `onValueChange`
 * props; `trackColor.true` maps to the native accent (SwiftUI toggle tint /
 * Compose checked track).
 */

export interface NativeSwitchProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  /** Compatibility with RN Switch call sites; `true` maps to native accent. */
  trackColor?: { true?: string; false?: string };
  testID?: string;
}

// --- Safe optional import of @expo/ui universal Switch + Host ----------------
type ExpoUiSwitchProps = {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
  modifiers?: unknown[];
};
type ExpoUiHostProps = {
  matchContents?: boolean | { horizontal?: boolean; vertical?: boolean };
  style?: object;
  children?: React.ReactNode;
};

type NativeSwitchModule = {
  available: boolean;
  Switch: React.ComponentType<ExpoUiSwitchProps> | null;
  Host: React.ComponentType<ExpoUiHostProps> | null;
  tint: ((color: string) => unknown) | null;
};

const NativeMod: NativeSwitchModule = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@expo/ui");
    const Switch = mod?.Switch ?? null;
    const Host = mod?.Host ?? null;
    let tint: ((color: string) => unknown) | null = null;
    try {
      // Modifier used to tint the toggle to the app accent (SwiftUI).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const swiftMods = require("@expo/ui/swift-ui/modifiers");
      tint = swiftMods?.tint ?? null;
    } catch {
      tint = null;
    }
    return { available: !!(Switch && Host), Switch, Host, tint };
  } catch {
    return { available: false, Switch: null, Host: null, tint: null };
  }
})();

export const nativeSwitchAvailable = NativeMod.available;

export default function NativeSwitch({
  value,
  onValueChange,
  disabled,
  trackColor,
  testID,
}: NativeSwitchProps) {
  const theme = useTheme();
  const { Switch, Host, tint } = NativeMod;

  if (!Switch || !Host) {
    // Fallback: React Native core Switch (preserves trackColor).
    return (
      <RNSwitch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{
          true: trackColor?.true ?? theme.primary,
          false: trackColor?.false ?? theme.inputBorder,
        }}
        testID={testID}
      />
    );
  }

  const accent = trackColor?.true ?? theme.primary;
  const modifiers = tint ? [tint(accent)] : undefined;

  return (
    <Host matchContents>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        testID={testID}
        modifiers={modifiers}
      />
    </Host>
  );
}