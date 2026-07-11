import NativeSelectField, {
  nativeSelectAvailable,
} from "./native/NativeSelectField";
import {
  Dropdown as LegacyDropdown,
  MultiDropdown as LegacyMultiDropdown,
  type DropdownOption,
} from "./Dropdown.fallback";

export type { DropdownOption } from "./Dropdown.fallback";

/**
 * Single-select dropdown. Prefers the OS-native `@expo/ui` Picker (SwiftUI wheel
 * on iOS, Material 3 exposed dropdown on Android) and transparently falls back
 * to the pure-JS bottom-sheet implementation (`Dropdown.fallback.tsx`) when the
 * native module isn't available at runtime.
 *
 * Public API is unchanged (`label`, `value`, `options`, `onChange`,
 * `placeholder`) so no call sites need updating.
 */
export function Dropdown(props: {
  label?: string;
  value: string | number | null;
  options: DropdownOption[];
  onChange: (value: string | number | null) => void;
  placeholder?: string;
}) {
  if (!nativeSelectAvailable) {
    return <LegacyDropdown {...props} />;
  }

  const { label, value, options, onChange, placeholder } = props;
  return (
    <NativeSelectField
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      placeholder={placeholder}
    />
  );
}

/**
 * Multi-select dropdown (used for Labels). `@expo/ui`'s Picker is single-select
 * only, so this keeps the pure-JS checklist bottom-sheet implementation.
 */
export const MultiDropdown = LegacyMultiDropdown;