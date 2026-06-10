import { useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Check, ChevronDown, X } from "lucide-react-native";
import { theme } from "../theme";

export type DropdownOption = {
  value: string | number | null;
  label: string;
  /** Optional colored dot shown before the label (e.g. label/type/priority). */
  color?: string;
};

/**
 * A native select-style dropdown that mirrors the web app's <select> controls.
 * Tapping the field opens a bottom sheet modal with the list of options. Used
 * for single-select fields (Assignee, Sprint, Type) in the new-task form.
 */
export function Dropdown({
  label,
  value,
  options,
  onChange,
  placeholder = "Select…",
}: {
  label?: string;
  value: string | number | null;
  options: DropdownOption[];
  onChange: (value: string | number | null) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => options.find((o) => String(o.value) === String(value)),
    [options, value],
  );

  return (
    <>
      <Pressable style={styles.field} onPress={() => setOpen(true)}>
        <View style={styles.fieldInner}>
          {selected?.color ? (
            <View style={[styles.dot, { backgroundColor: selected.color }]} />
          ) : null}
          <Text
            style={[styles.fieldText, !selected && styles.fieldPlaceholder]}
            numberOfLines={1}
          >
            {selected ? selected.label : placeholder}
          </Text>
        </View>
        <ChevronDown size={18} color={theme.textSecondary} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{label || "Select"}</Text>
              <Pressable onPress={() => setOpen(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <FlatList
              data={options}
              keyExtractor={(o) => String(o.value)}
              style={{ maxHeight: 360 }}
              renderItem={({ item }) => {
                const active = String(item.value) === String(value);
                return (
                  <Pressable
                    style={styles.option}
                    onPress={() => {
                      onChange(item.value);
                      setOpen(false);
                    }}
                  >
                    {item.color ? (
                      <View
                        style={[styles.dot, { backgroundColor: item.color }]}
                      />
                    ) : null}
                    <Text
                      style={[styles.optionText, active && styles.optionTextActive]}
                      numberOfLines={1}
                    >
                      {item.label}
                    </Text>
                    {active ? <Check size={18} color={theme.primary} /> : null}
                  </Pressable>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/**
 * Multi-select dropdown variant (used for Labels). Selected values are kept in
 * an array; the field summarises the count of selected items.
 */
export function MultiDropdown({
  label,
  values,
  options,
  onChange,
  placeholder = "Select…",
}: {
  label?: string;
  values: (string | number)[];
  options: DropdownOption[];
  onChange: (values: (string | number)[]) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedOpts = useMemo(
    () => options.filter((o) => values.some((v) => String(v) === String(o.value))),
    [options, values],
  );

  function toggle(value: string | number | null) {
    if (value == null) return;
    const exists = values.some((v) => String(v) === String(value));
    onChange(
      exists
        ? values.filter((v) => String(v) !== String(value))
        : [...values, value],
    );
  }

  return (
    <>
      <Pressable style={styles.field} onPress={() => setOpen(true)}>
        <View style={styles.fieldInner}>
          <Text
            style={[
              styles.fieldText,
              selectedOpts.length === 0 && styles.fieldPlaceholder,
            ]}
            numberOfLines={1}
          >
            {selectedOpts.length === 0
              ? placeholder
              : selectedOpts.map((o) => o.label).join(", ")}
          </Text>
        </View>
        <ChevronDown size={18} color={theme.textSecondary} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{label || "Select"}</Text>
              <Pressable onPress={() => setOpen(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <FlatList
              data={options}
              keyExtractor={(o) => String(o.value)}
              style={{ maxHeight: 360 }}
              renderItem={({ item }) => {
                const active = values.some(
                  (v) => String(v) === String(item.value),
                );
                return (
                  <Pressable style={styles.option} onPress={() => toggle(item.value)}>
                    {item.color ? (
                      <View
                        style={[styles.dot, { backgroundColor: item.color }]}
                      />
                    ) : null}
                    <Text
                      style={[styles.optionText, active && styles.optionTextActive]}
                      numberOfLines={1}
                    >
                      {item.label}
                    </Text>
                    {active ? <Check size={18} color={theme.primary} /> : null}
                  </Pressable>
                );
              }}
            />
            <Pressable style={styles.doneBtn} onPress={() => setOpen(false)}>
              <Text style={styles.doneBtnText}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  fieldInner: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  fieldText: { color: theme.text, fontSize: 15, flex: 1 },
  fieldPlaceholder: { color: theme.textMuted },
  dot: { width: 10, height: 10, borderRadius: 5 },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: "80%",
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: theme.text },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  optionText: { color: theme.text, fontSize: 15, flex: 1 },
  optionTextActive: { color: theme.primary, fontWeight: "600" },
  doneBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 14,
  },
  doneBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});