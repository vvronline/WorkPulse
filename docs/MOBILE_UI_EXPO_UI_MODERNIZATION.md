# Mobile UI Modernization — `@expo/ui` Adoption Plan

Analysis of the WorkPulse mobile app UI against
[Expo UI (`@expo/ui`)](https://docs.expo.dev/versions/latest/sdk/ui/), plus a
phased modernization plan and a record of what has been implemented.

---

## 1. Current UI Architecture (baseline)

| Area | Implementation | Notes |
|---|---|---|
| Design system | Hand-rolled token factory `src/theme.ts` (`makeTheme(accent)`) via `ThemeProvider` + `useTheme()` | Dark-only, mirrors web `global.css`. Solid — kept as-is. |
| **Date picker** | `DatePicker.tsx` — custom pure-JS month-grid in a `Modal` (~330 lines) | Reinvented a native control. **Migrated (Phase 1).** |
| **Time picker** | `TimePicker.tsx` — custom `Modal` hour/minute wheels (~280 lines) | **Migrated (Phase 1).** |
| Month picker | `MonthPicker.tsx` — custom `Modal` | **Stays JS** — `@expo/ui` has no month picker; a date picker would force day-level selection. |
| Dropdown (single) | `Dropdown.tsx` — custom bottom-sheet `Modal` + `FlatList` | **Migrated (Phase 2)** → `@expo/ui` `Picker`. |
| MultiDropdown | `Dropdown.tsx` — multi-select checklist sheet | **Stays JS** — `@expo/ui` `Picker` is single-select only. |
| Color picker | `react-native-wheel-color-picker` | **Stays as-is (Phase 5)** — `@expo/ui` has no color-picker component. |
| Confirm / Prompt dialogs | Custom `Modal` overlays | Phase 4 candidate. |
| Toggles | RN core `<Switch>` (`LeavesTab`) | **Migrated (Phase 3)** → `@expo/ui` universal `Switch`. |
| Bottom sheets | Repeated custom `Modal` + backdrop + `stopPropagation` | **Migrated (Phase 4)** — shared `NativeBottomSheet` wrapper; `AttachmentPicker`, `DeleteOptionsSheet`, `MessageActionsSheet`, `HeaderMenuSheet` migrated. |
| Icons | `react-native-heroicons` + `react-native-svg` | Keep. |
| Lists | `@shopify/flash-list` 2.1 | Modern — keep. |
| Animation / gesture | `react-native-reanimated` 4.3, `gesture-handler` 2.31 | Modern — keep. |
| Runtime | Expo SDK **56**, RN **0.85**, React **19**, New Architecture (Fabric) | Ready for `@expo/ui`. |

**Core finding:** the app hand-builds several primitives (date, time, month,
dropdown, dialogs) as JS `Modal` overlays. `@expo/ui` renders these natively
(SwiftUI / Jetpack Compose) — better platform feel, less code to maintain.

---

## 2. `@expo/ui` capabilities (from the docs)

- Native input components on **Jetpack Compose (Android)** + **SwiftUI (iOS)**,
  plus a **Universal** set. Included in Expo Go; works with the New Architecture.
- Installed version in this repo: **`@expo/ui@56.0.21`** (SDK 56 compatible —
  **no SDK upgrade required**).
- Relevant exports:
  - `@expo/ui/community/datetime-picker` → **`DateTimePicker`** (drop-in API
    matching `@react-native-community/datetimepicker`) — **used in Phase 1**
  - `@expo/ui/community/picker` → `Picker`
  - `@expo/ui/community/segmented-control` → `SegmentedControl`
  - `@expo/ui/community/slider` → `Slider`
  - `@expo/ui/community/bottom-sheet` → `BottomSheet`
  - `@expo/ui/community/menu` → context menu
  - `@expo/ui/community/pager-view`, `.../masked-view`
  - SwiftUI / Jetpack Compose declarative primitives (`Host`, `Button`, `List`,
    `Section`, etc.)

> ⚠️ `@expo/ui` is still experimental; its API can shift between SDKs. Adopt
> **behind adapters**, one primitive at a time, with a JS fallback.

### `DateTimePicker` behavior (community drop-in)
- Props: `value: Date`, `onValueChange(event, date)` (or legacy `onChange`),
  `mode: 'date' | 'time' | 'datetime'`, `minimumDate`, `maximumDate`,
  `display`, `is24Hour`, `accentColor`, `themeVariant`, plus Android
  `presentation: 'inline' | 'dialog'` (+ `onDismiss`, button labels).
- **Android**: `presentation="dialog"` mounts a native dialog that opens on
  mount; the caller unmounts it on select/dismiss.
- **iOS**: always **inline** (dialog presentation is ignored) — so we host the
  inline picker inside the app's themed modal with a Done/Cancel action.

---

## 3. Modernization Plan (phased)

| Phase | Scope | Effort | Risk | Value | Status |
|---|---|---|---|---|---|
| 0 | Install `@expo/ui` + adapter layer | Med | Low | Enables all | ✅ Done |
| 1 | Date/Time pickers → native `DateTimePicker` | Low–Med | Low | ⭐⭐⭐ | ✅ Done |
| 2 | `Dropdown` (single-select) → native `Picker` | Med | Low | ⭐⭐ | ✅ Done |
| 3 | `Switch` → native universal `Switch` | Low | Low | ⭐ | ✅ Done |
| 4 | Custom sheets → shared native `BottomSheet` wrapper | Med–High | Med | ⭐⭐ | ✅ Done |
| 5 | Color picker (drop `wheel-color-picker` if replaceable) | Low | Low | ⭐ | ✅ Assessed — keep as-is |

### Cross-cutting cleanups (independent of `@expo/ui`)
- ✅ **Done** — moved the co-located `*.styles.ts` files out of the `app/`
  router tree into `src/screens/tabStyles/`, updated the 3 screen imports, and
  removed the `href: null` route-leak workaround from `(tabs)/_layout.tsx`.
- ✅ **Done** — consolidated the chat/action sheets behind the shared
  `NativeBottomSheet` wrapper (Phase 4), removing the repeated
  backdrop/`stopPropagation` boilerplate.

---

## 4. Phase 0 + 1 — What was implemented

### Adapter (new)
- `src/components/native/NativeDateTimeField.tsx`
  - Themed pressable trigger field + native `@expo/ui` `DateTimePicker`.
  - **Safe optional import**: `@expo/ui` is `require`d inside a try/catch;
    `nativeDateTimeAvailable` is `false` if the module can't load, so callers
    fall back to the JS implementation (no bundle crash).
  - Platform-correct presentation: Android native **dialog** (opens on mount,
    torn down on select/dismiss); iOS **inline** picker inside a themed modal
    with Cancel / Done (Done commits a draft selection).
  - Uses `theme.primary` as `accentColor`, `themeVariant="dark"`.

### Migrated (same public API — zero call-site changes)
- `src/components/DatePicker.tsx`
  - Native-first; falls back to `DatePicker.fallback.tsx`.
  - Public API unchanged: `value: "YYYY-MM-DD"`, `onChange`, `minDate`,
    `maxDate`, `placeholder`, `disabled`. Converts `Date` ⇄ `YYYY-MM-DD`
    (local) at the boundary.
- `src/components/TimePicker.tsx`
  - Native-first; falls back to `TimePicker.fallback.tsx`.
  - Public API unchanged: `value: "HH:mm"` (24h), `onChange`, `placeholder`,
    `disabled`. Converts `Date` ⇄ `HH:mm` at the boundary; keeps the 12h AM/PM
    field label.

### Preserved fallbacks
- `src/components/DatePicker.fallback.tsx` — original pure-JS month-grid.
- `src/components/TimePicker.fallback.tsx` — original pure-JS hour/minute wheel.

### Verification
- `npx tsc --noEmit` → **passes (exit 0)**, no picker-related type errors.
- Babel: `@expo/ui`'s babel plugin is **not** required for the community
  `DateTimePicker` drop-in (it only tree-shakes the declarative SwiftUI/Compose
  modifier API), so `babel.config.js` is unchanged.

### Manual device verification (run before shipping)
The native pickers require a **development/native build** (they render real
SwiftUI / Jetpack Compose views):

```bash
cd mobile
npx expo run:android   # or: npx expo run:ios
```

Then exercise every picker call site:
- Leaves → Apply (start/end dates)
- Tasks → New / Edit (due date)
- Manual attendance entry (date + time)
- Any attendance/report date filters

Confirm: native picker opens, selection round-trips to the same
`YYYY-MM-DD` / `HH:mm` strings, min/max bounds respected, dark theme + accent
color applied. If a device runtime lacks the module, the JS fallback renders
automatically.

---

## 5. Phase 2 — What was implemented

### Adapter (new)
- `src/components/native/NativeSelectField.tsx`
  - Themed pressable trigger field + native `@expo/ui` `Picker` (SwiftUI wheel
    on iOS, Material 3 exposed dropdown on Android), hosted inside a themed
    bottom-sheet modal with Cancel / Done (Done commits a draft selection).
  - **Safe optional import**: `nativeSelectAvailable` is `false` if `@expo/ui`
    can't load, so callers fall back to the JS Dropdown (no bundle crash).

### Migrated (same public API — zero call-site changes)
- `src/components/Dropdown.tsx`
  - `Dropdown` (single-select) is now native-first; falls back to
    `Dropdown.fallback.tsx`. Public API unchanged (`label`, `value`, `options`,
    `onChange`, `placeholder`; `DropdownOption { value, label, color }`).
  - `MultiDropdown` is re-exported unchanged from the fallback — `@expo/ui`'s
    `Picker` is single-select only, so the JS checklist sheet remains.

### Preserved fallback
- `src/components/Dropdown.fallback.tsx` — original pure-JS single- and
  multi-select bottom-sheet dropdowns.

### Decisions
- **`MonthPicker` left on JS**: `@expo/ui` has no month picker, and reusing the
  native date picker would force day-level selection — a UX regression for a
  month field. Revisit if a native month/segmented option appears.
- **`MultiDropdown` left on JS**: no native multi-select control exists.

### Verification
- `npx tsc --noEmit` → **passes (exit 0)**, no dropdown/picker type errors.
- Call sites unchanged: single-select `Dropdown` usages (e.g. new-task form
  Assignee / Sprint / Type) automatically get the native picker in a dev build;
  `MultiDropdown` (Labels) keeps the JS sheet.

---

## 6. Phase 3 — What was implemented

### Adapter (new)
- `src/components/native/NativeSwitch.tsx`
  - Renders `@expo/ui`'s universal `Switch` (SwiftUI `Toggle` on iOS, Material 3
    `Switch` on Android) wrapped in the required `Host` bridge.
  - **Safe optional import**: falls back to React Native's core `<Switch>` when
    `@expo/ui` can't load (`nativeSwitchAvailable`).
  - Drop-in for RN `<Switch>` call sites: same `value` / `onValueChange`;
    `trackColor.true` maps to the native accent via the SwiftUI `tint` modifier
    (and is preserved on the RN fallback).

### Migrated
- `src/components/LeavesTab.tsx` — both policy toggles ("Allow Half-day
  requests", "Allow Quarter-day requests") now use `NativeSwitch`; the RN core
  `Switch` import was removed.

### Decision
- **`Slider` not adopted**: the app has no range/slider inputs today, so there's
  nothing to migrate. `@expo/ui/community/slider` is available if one is added.

### Verification
- `npx tsc --noEmit` → **passes (exit 0)**, no switch/leaves type errors.

---

## 7. Phase 4 — What was implemented

### Adapter (new)
- `src/components/native/NativeBottomSheet.tsx`
  - Shared bottom-sheet wrapper with a simple controlled `visible` / `onClose`
    API. Renders `@expo/ui`'s native bottom sheet (SwiftUI `.sheet` on iOS,
    Material 3 `ModalBottomSheet` on Android — real detents, drag indicator,
    swipe-to-dismiss). Drives visibility via the sheet's `index` prop
    (`-1` closed / `0` open); `onClose` fires on swipe-down / scrim tap / back
    button as well as programmatically.
  - **Safe optional import**: `nativeBottomSheetAvailable` is `false` if
    `@expo/ui` can't load, so it falls back to the app's themed JS `Modal`
    bottom-sheet (mirroring the previous hand-rolled UX). Removes the repeated
    `Modal` + backdrop + `stopPropagation` boilerplate at each call site.
  - Optional `snapPoints` (defaults to content-sized dynamic sizing) and
    `backgroundColor` (defaults to `theme.bgElevated`).

### Migrated (all four chat/action sheets)
- `src/components/chat/AttachmentPicker.tsx` — the "+" composer attach sheet.
- `src/components/chat/DeleteOptionsSheet.tsx` — the message delete chooser.
- `src/components/chat/MessageActionsSheet.tsx` — the message action / "Forward
  to…" sheet (moved from a centered modal to a native bottom sheet).
- `src/components/chat/HeaderMenuSheet.tsx` — the header 3-dot menu + its
  search / pinned / files / saved panels (uses an `85%` snap point for the
  scrollable panels).

All four dropped their hand-rolled `Modal` + backdrop + `stopPropagation`
scaffolding; public props are unchanged, so their call sites are untouched.

### Verification
- `npx tsc --noEmit` → **passes (exit 0)** across the whole mobile project.

### Optional future follow-up
- A native context `Menu` (`@expo/ui/community/menu`) could further refine the
  message/header action menus (anchored popover vs. bottom sheet), but the
  bottom-sheet form already gives a native feel and is consistent across the app.

---

## 8. Phase 5 — Color picker (assessed)

- **Decision: keep `react-native-wheel-color-picker` as-is.** `@expo/ui`'s
  component set (bottom-sheet, datetime-picker, masked-view, menu, pager-view,
  picker, segmented-control, slider) has **no color-picker**, so there is no
  native equivalent to migrate to. `ColorPicker.tsx` is unchanged.

---

## 9. Status — all phases complete

Every planned phase is done and the full project type-checks clean
(`npx tsc --noEmit` → exit 0):

- ✅ Phase 0 — `@expo/ui@56.0.21` installed + `src/components/native/` adapter layer
- ✅ Phase 1 — native Date/Time pickers (`DatePicker`, `TimePicker`)
- ✅ Phase 2 — native single-select `Dropdown`
- ✅ Phase 3 — native universal `Switch` (`LeavesTab`)
- ✅ Phase 4 — shared `NativeBottomSheet`; 4 chat/action sheets migrated
- ✅ Phase 5 — color picker assessed → keep as-is (no native equivalent)
- ✅ Cross-cutting cleanup — tab style files moved out of the router tree; the
  `href: null` route-leak workaround removed

### Before shipping
All native `@expo/ui` components render real SwiftUI / Jetpack Compose views, so
validate in a **development/native build** (`npx expo run:android` /
`npx expo run:ios`). Every adapter falls back to its JS implementation when the
native module is unavailable, so nothing regresses in JS-only runtimes.
