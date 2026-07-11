import {
  Dropdown as LegacyDropdown,
  MultiDropdown as LegacyMultiDropdown,
  type DropdownOption,
} from "./Dropdown.fallback";

export type { DropdownOption } from "./Dropdown.fallback";

/**
 * Single-select dropdown. Uses the pure-JS, fully app-themed bottom-sheet
 * implementation (`Dropdown.fallback.tsx`).
 *
 * NOTE: A previous refactor switched this to the OS-native `@expo/ui` Picker
 * (`NativeSelectField`), but that picker renders with the OS's own styling
 * (ignoring the app theme) and had unreliable selection behavior. We revert to
 * the themed JS implementation, which matches the rest of the app and works
 * consistently. `NativeSelectField.tsx` is kept in the repo for future use.
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
  return <LegacyDropdown {...props} />;
}

/**
 * Multi-select dropdown (used for Labels). `@expo/ui`'s Picker is single-select
 * only, so this keeps the pure-JS checklist bottom-sheet implementation.
 */
export const MultiDropdown = LegacyMultiDropdown;