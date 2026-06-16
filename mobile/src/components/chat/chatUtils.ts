import type { ChatMessage } from "../../features";

// Quick-reaction row — matches the web MessageToolbar QUICK_EMOJIS exactly.
export const EMOJIS = [
  "\u{1F44D}", // 👍
  "\u2764\uFE0F", // ❤️
  "\u{1F602}", // 😂
  "\u{1F62E}", // 😮
  "\u{1F525}", // 🔥
  "\u{1F389}", // 🎉
];

// Full emoji set for the "All Emoji" browser (grouped, common reactions).
export const ALL_EMOJIS = [
  "\u{1F600}","\u{1F603}","\u{1F604}","\u{1F601}","\u{1F606}","\u{1F605}","\u{1F923}","\u{1F602}",
  "\u{1F642}","\u{1F643}","\u{1F609}","\u{1F60A}","\u{1F607}","\u{1F970}","\u{1F60D}","\u{1F929}",
  "\u{1F618}","\u{1F617}","\u{1F61A}","\u{1F619}","\u{1F60B}","\u{1F61B}","\u{1F61C}","\u{1F92A}",
  "\u{1F60E}","\u{1F913}","\u{1F9D0}","\u{1F914}","\u{1F910}","\u{1F644}","\u{1F60F}","\u{1F612}",
  "\u{1F62E}","\u{1F627}","\u{1F632}","\u{1F633}","\u{1F97A}","\u{1F622}","\u{1F62D}","\u{1F624}",
  "\u{1F620}","\u{1F621}","\u{1F92C}","\u{1F634}","\u{1F60C}","\u{1F614}","\u{1F61F}","\u{1F625}",
  "\u{1F44D}","\u{1F44E}","\u{1F44F}","\u{1F64C}","\u{1F450}","\u{1F932}","\u{1F91D}","\u{1F64F}",
  "\u270C\uFE0F","\u{1F91E}","\u{1F44C}","\u{1F90F}","\u{1F44A}","\u270A","\u{1F4AA}","\u{1F525}",
  "\u2764\uFE0F","\u{1F9E1}","\u{1F49B}","\u{1F49A}","\u{1F499}","\u{1F49C}","\u{1F5A4}","\u{1F90D}",
  "\u{1F389}","\u{1F38A}","\u2728","\u2B50","\u{1F31F}","\u{1F4AF}","\u2705","\u274C",
];

export function isImageFile(m: ChatMessage): boolean {
  if (m.file_type && m.file_type.startsWith("image/")) return true;
  const name = (m.file_name || m.file_url || "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|heic|bmp)$/.test(name);
}

export function isAudioFile(m: ChatMessage): boolean {
  if (m.file_type && m.file_type.startsWith("audio/")) return true;
  const name = (m.file_name || m.file_url || "").toLowerCase();
  return /\.(m4a|mp3|aac|ogg|wav|webm)$/.test(name);
}

export function fmtSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtRecTime(ms?: number): string {
  const total = Math.round((ms || 0) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function fmtTime(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtDateTime(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${fmtTime(iso)}`;
}

// Human label for the peer's effective status shown under the chat name in
// the header (mirrors the web ChatHeader STATUS_LABEL; "available" reads as
// "Online" like the web's online fallback).
export const STATUS_LABEL: Record<string, string> = {
  available: "Online",
  busy: "Busy",
  dnd: "Do Not Disturb",
  brb: "Be Right Back",
  away: "Away",
  offline: "Offline",
  in_call: "In a Call",
  in_meeting: "In a Meeting",
};

// Header 3-dot menu sheet contents. A single modal switches between the menu
// and each panel — presenting separate modals back-to-back races on Android
// (see the forwardMode comment in the screen for the same pattern).
export type HeaderSheet = null | "menu" | "search" | "pinned" | "files" | "saved";