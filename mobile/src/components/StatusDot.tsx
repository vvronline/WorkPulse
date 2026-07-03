import { StyleSheet, View } from "react-native";
import { Check, Clock3, Minus, Phone, Video } from "../icons";

/**
 * Status dot used on chat avatars and the profile header. Mirrors the web
 * `client/src/components/chat/ChatAvatar.tsx` status config and
 * `client/src/status/constants.ts` STATUS_META so colors/glyphs match.
 *
 * Both `brb` (manual "be right back") and `away` (server-derived idle) share
 * the same amber styling — the user thinks of them as the same state.
 */

export type StatusGlyph =
  | "check"
  | "dot"
  | "minus"
  | "clock"
  | "phone"
  | "video"
  | "ring";

export type StatusMetaEntry = {
  label: string;
  color: string;
  glyph: StatusGlyph;
};

export const STATUS_META: Record<string, StatusMetaEntry> = {
  available: { label: "Available", color: "#22c55e", glyph: "check" },
  busy: { label: "Busy", color: "#ef4444", glyph: "dot" },
  dnd: { label: "Do Not Disturb", color: "#ef4444", glyph: "minus" },
  brb: { label: "Away", color: "#f59e0b", glyph: "clock" },
  away: { label: "Away", color: "#f59e0b", glyph: "clock" },
  in_call: { label: "In a Call", color: "#ef4444", glyph: "phone" },
  in_meeting: { label: "In a Meeting", color: "#0ea5e9", glyph: "video" },
  offline: { label: "Offline", color: "#64748b", glyph: "ring" },
};

export function metaForStatus(status?: string | null): StatusMetaEntry {
  if (!status) return STATUS_META.offline;
  return STATUS_META[status] || STATUS_META.offline;
}

function GlyphIcon({
  glyph,
  size,
  color = "#fff",
}: {
  glyph: StatusGlyph;
  size: number;
  color?: string;
}) {
  if (glyph === "check") return <Check size={size} color={color} strokeWidth={3} />;
  if (glyph === "minus") return <Minus size={size} color={color} strokeWidth={3} />;
  if (glyph === "clock") return <Clock3 size={size} color={color} strokeWidth={2.6} />;
  if (glyph === "phone") return <Phone size={size} color={color} strokeWidth={2.6} />;
  if (glyph === "video") return <Video size={size} color={color} strokeWidth={2.6} />;
  return null;
}

export default function StatusDot({
  status,
  meta,
  size = 14,
  borderColor,
}: {
  status?: string | null;
  meta?: StatusMetaEntry;
  size?: number;
  // Ring border color (typically the surrounding surface) so the dot reads as
  // an overlay on an avatar.
  borderColor?: string;
}) {
  const m = meta || metaForStatus(status);
  const isRing = m.glyph === "ring";
  const ring = borderColor ? 2 : 0;
  return (
    <View
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: isRing ? "transparent" : m.color,
          borderWidth: isRing ? 2 : ring,
          borderColor: isRing ? m.color : borderColor || "transparent",
        },
      ]}
    >
      {!isRing && <GlyphIcon glyph={m.glyph} size={Math.round(size * 0.55)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: { alignItems: "center", justifyContent: "center" },
});