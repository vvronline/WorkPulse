import { useMemo } from "react";
import { Linking, StyleSheet, Text } from "react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";
import { emojiOnlyCount } from "./chatUtils";

// Linkify regex — matches http(s):// URLs as well as bare www. URLs (Signal's
// LinkifyText recognises both). Used with a global flag to tokenize the body
// into plain-text + URL segments. Kept here (not chatUtils' single-match
// URL_RE) because rendering needs EVERY url, with its offsets, not just the
// first one.
const LINKIFY_RE = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;

// Strip trailing punctuation that commonly hugs a URL in prose (e.g. a period
// or closing bracket) so it isn't swallowed into the tappable link.
function trimTrailingPunctuation(url: string): {
  url: string;
  trailing: string;
} {
  const m = url.match(/[).,!?;:'"\]]+$/);
  if (!m) return { url, trailing: "" };
  const trailing = m[0];
  return { url: url.slice(0, url.length - trailing.length), trailing };
}

// Open a (possibly bare www.) URL in the system browser. Bare URLs are
// normalised to https:// so Linking.openURL accepts them.
function openLink(raw: string) {
  const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  Linking.openURL(href).catch(() => {});
}

type Segment = { text: string; url?: string };

// Split a message body into alternating plain-text / URL segments so the URL
// parts can render as tappable accent-coloured spans (Signal parity).
function tokenize(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(LINKIFY_RE)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      segments.push({ text: text.slice(lastIndex, idx) });
    }
    const { url, trailing } = trimTrailingPunctuation(match[0]);
    segments.push({ text: url, url });
    if (trailing) segments.push({ text: trailing });
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }
  return segments;
}

/**
 * Renders a message's text body (mirrors the web MessageContent). Shows the
 * "deleted" placeholder when the message has been removed. Returns null when
 * there's nothing to show (e.g. an attachment-only message). URLs in the body
 * are linkified into tappable spans that open in the system browser (Signal's
 * LinkifyText behaviour) — they were previously shown as plain, un-tappable
 * text.
 */
export default function MessageContent({
  message,
  mine,
}: {
  message: ChatMessage;
  mine?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const deleted = !!message.deleted_at;
  // Tokenize the (non-deleted) body so URL segments become tappable links.
  const segments = useMemo(
    () => (deleted ? null : tokenize(message.content || "")),
    [deleted, message.content],
  );
  const emojiCount = deleted ? 0 : emojiOnlyCount(message.content);
  if (!message.content && !deleted) return null;
  return (
    <Text
      style={[
        styles.content,
        // WhatsApp-style: own bubbles use the accent fill, so text is white.
        mine && !deleted && styles.contentMine,
        deleted && styles.deleted,
        // Signal JUMBOMOJI size tiers: a single emoji renders largest, 2–3
        // medium, 4–5 smaller (mirrors Signal-Android EmojiTextView scaling).
        emojiCount === 1 && styles.emojiOnly1,
        (emojiCount === 2 || emojiCount === 3) && styles.emojiOnly3,
        emojiCount >= 4 && styles.emojiOnly5,
      ]}
    >
      {deleted
        ? "This message was deleted"
        : segments!.map((seg, i) =>
            seg.url ? (
              <Text
                key={i}
                style={[styles.link, mine && styles.linkMine]}
                onPress={() => openLink(seg.url!)}
                suppressHighlighting
              >
                {seg.text}
              </Text>
            ) : (
              seg.text
            ),
          )}
    </Text>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // Signal-Android message body text (16sp, ~22sp line height).
    content: { fontSize: 16, color: theme.text, lineHeight: 22 },
    contentMine: { color: "#fff" },
    deleted: { fontStyle: "italic", color: theme.textMuted },
    // Tappable URL span. On incoming bubbles it tints with the brand accent
    // (Signal underlines + tints links); on own (accent-filled) bubbles the
    // white text just gets an underline so it stays legible.
    link: { color: theme.primaryLight, textDecorationLine: "underline" },
    linkMine: { color: "#fff", textDecorationLine: "underline" },
    // Signal-style jumbomoji tiers (frameless — see MessageBubble
    // bubbleEmojiOnly): 1 emoji = largest, 2–3 = medium, 4–5 = smaller.
    emojiOnly1: { fontSize: 48, lineHeight: 58 },
    emojiOnly3: { fontSize: 38, lineHeight: 46 },
    emojiOnly5: { fontSize: 30, lineHeight: 38 },
  });
