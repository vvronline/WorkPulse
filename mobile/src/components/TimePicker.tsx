import { Clock } from "../icons";
import { useTheme } from "../theme/ThemeProvider";
import NativeDateTimeField, {
  nativeDateTimeAvailable,
} from "./native/NativeDateTimeField";
import LegacyTimePicker, { type TimePickerProps } from "./TimePicker.fallback";

export type { TimePickerProps } from "./TimePicker.fallback";

/* ── time <-> string helpers (HH:mm, 24-hour) ── */

function parseHHMM(value?: string): { h: number; m: number } | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [h, m] = value.split(":").map((n) => parseInt(n, 10));
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

function toHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

function to12h(h: number, m: number): string {
  const period = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${period}`;
}

/** Build a Date carrying the given HH:mm on today's date. */
function dateFromHHMM(parsed: { h: number; m: number } | null): Date | null {
  if (!parsed) return null;
  const d = new Date();
  d.setHours(parsed.h, parsed.m, 0, 0);
  return d;
}

/**
 * Time picker field. Prefers the OS-native `@expo/ui` DateTimePicker (SwiftUI /
 * Jetpack Compose) and transparently falls back to the pure-JS hour/minute
 * wheel implementation (`TimePicker.fallback.tsx`) when the native module isn't
 * available at runtime.
 *
 * Public API is unchanged: value is an `HH:mm` (24-hour) string, `onChange`
 * emits the same, and `placeholder`/`disabled` behave as before — so no call
 * sites need updating.
 */
export default function TimePicker(props: TimePickerProps) {
  const theme = useTheme();

  if (!nativeDateTimeAvailable) {
    return <LegacyTimePicker {...props} />;
  }

  const { value, onChange, placeholder = "Select time", disabled } = props;

  const parsed = parseHHMM(value);
  const label = parsed ? to12h(parsed.h, parsed.m) : placeholder;

  return (
    <NativeDateTimeField
      mode="time"
      date={dateFromHHMM(parsed)}
      hasValue={!!parsed}
      label={label}
      disabled={disabled}
      icon={<Clock size={16} color={theme.textSecondary} />}
      onSelect={(d) => onChange(toHHMM(d))}
    />
  );
}