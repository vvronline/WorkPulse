import { Calendar as CalendarIcon } from "../icons";
import { useTheme } from "../theme/ThemeProvider";
import NativeDateTimeField, {
  nativeDateTimeAvailable,
} from "./native/NativeDateTimeField";
import LegacyDatePicker, { type DatePickerProps } from "./DatePicker.fallback";

export type { DatePickerProps } from "./DatePicker.fallback";

/* ── date <-> string helpers (YYYY-MM-DD, local) ── */

function parseYMD(value?: string): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function toYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * Date picker field. Prefers the OS-native `@expo/ui` DateTimePicker (SwiftUI /
 * Jetpack Compose) and transparently falls back to the pure-JS month-grid
 * implementation (`DatePicker.fallback.tsx`) when the native module isn't
 * available at runtime.
 *
 * Public API is unchanged: value is a `YYYY-MM-DD` string, `onChange` emits the
 * same, and `minDate`/`maxDate`/`placeholder`/`disabled` behave as before — so
 * no call sites need updating.
 */
export default function DatePicker(props: DatePickerProps) {
  const theme = useTheme();

  if (!nativeDateTimeAvailable) {
    return <LegacyDatePicker {...props} />;
  }

  const {
    value,
    onChange,
    minDate,
    maxDate,
    placeholder = "Select date",
    disabled,
  } = props;

  const selected = parseYMD(value);
  const label = selected
    ? selected.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : placeholder;

  return (
    <NativeDateTimeField
      mode="date"
      date={selected}
      hasValue={!!selected}
      label={label}
      disabled={disabled}
      minimumDate={parseYMD(minDate) ?? undefined}
      maximumDate={parseYMD(maxDate) ?? undefined}
      icon={<CalendarIcon size={16} color={theme.textSecondary} />}
      onSelect={(d) => onChange(toYMD(d))}
    />
  );
}