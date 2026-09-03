import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Vibration, View } from "react-native";
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from "expo-audio";
import { getNotificationPreviewDataUri } from "../../utils/notificationSoundPreview";
import { useAuth } from "../../auth/AuthContext";
import { toggleReaction, type ChatMessage } from "../../features";

type ThreadUser = ReturnType<typeof useAuth>["user"];

export type ReactionAnchor = {
  x: number;
  y: number;
  width: number;
  height: number;
  mine: boolean;
};

type UseChatMessageContextMenuOptions = {
  user: ThreadUser;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setText: Dispatch<SetStateAction<string>>;
  selectedIds: Set<number>;
  toggleSelect: (message: ChatMessage) => void;
  selectOnly: (message: ChatMessage) => void;
  windowWidth: number;
  windowHeight: number;
  insetTop: number;
};

/**
 * The long-press surfaces of a message row: the anchored reaction bar, the
 * message action sheet target, the emoji picker mode and the optimistic
 * reaction toggle (with its haptic + audible feedback).
 *
 * Bubble host nodes are registered here because the anchor rect is measured
 * from the native view, and `actionTarget` lives here because every action-sheet
 * entry point is reached through this same long-press surface.
 */
export default function useChatMessageContextMenu({
  user,
  setMessages,
  setText,
  selectedIds,
  toggleSelect,
  selectOnly,
  windowWidth,
  windowHeight,
  insetTop,
}: UseChatMessageContextMenuOptions) {
  const [reactTarget, setReactTarget] = useState<ChatMessage | null>(null);
  // Window-space rect of the long-pressed bubble so the reaction bar can be
  // positioned right next to it (matching the web behavior), instead of being
  // fixed in the middle of the screen.
  const [reactAnchor, setReactAnchor] = useState<ReactionAnchor | null>(null);
  const [barSize, setBarSize] = useState<{ width: number; height: number }>({
    width: 300,
    height: 44,
  });
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);
  const [showAllEmoji, setShowAllEmoji] = useState(false);
  // Whether the emoji grid inserts into the composer ("compose") or reacts to
  // the selected message ("react").
  const [emojiMode, setEmojiMode] = useState<"react" | "compose">("react");
  // Dedicated player for the short "reaction added" feedback tone, created
  // lazily on first use and released on unmount.
  const reactionSoundPlayerRef = useRef<AudioPlayer | null>(null);
  // Bubble host-node refs so we can reliably measure each bubble's window rect
  // for the reaction-bar anchor (Pressable forwards its ref to the host View,
  // which exposes measureInWindow — currentTarget often does not).
  const bubbleRefs = useRef<Map<number, View>>(new Map());

  // Release the lazily-created reaction-sound player when the thread unmounts.
  useEffect(
    () => () => {
      try {
        reactionSoundPlayerRef.current?.release();
      } catch {
        /* ignore */
      }
      reactionSoundPlayerRef.current = null;
    },
    [],
  );

  // Register/unregister a bubble's host node so the reaction bar can measure
  // it (see openReactionBar). Keeping this stable avoids re-registering on
  // every render.
  const registerBubbleRef = useCallback((msgId: number, node: View | null) => {
    if (node) bubbleRefs.current.set(msgId, node);
    else bubbleRefs.current.delete(msgId);
  }, []);

  // Short subtle tone played when a reaction is ADDED (Signal-style audible
  // feedback). Uses the same synthesized data-URI mechanism as the realtime
  // notification sounds so no audio asset is needed.
  function playReactionSound() {
    try {
      const uri = getNotificationPreviewDataUri("reaction", "subtle");
      if (!uri) return;
      setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      }).catch(() => {});
      // Create the native player on first use (kept off the chat-open path).
      let player = reactionSoundPlayerRef.current;
      if (!player) {
        player = createAudioPlayer();
        reactionSoundPlayerRef.current = player;
      }
      player.replace({ uri });
      player.play();
    } catch {
      /* no-op */
    }
  }

  async function react(message: ChatMessage, emoji: string) {
    if (message.deleted_at) return;
    setReactTarget(null);
    // Determine whether this toggle ADDS a reaction (vs removes it) so the
    // haptic + sound feedback only fires on add (Signal only buzzes/plays when
    // you place a reaction, not when you clear one).
    const willAdd = !(message.reactions || []).some(
      (r) => r.userId === user?.id && r.emoji === emoji,
    );
    // Optimistic toggle FIRST (mirrors web handleReact): the chip appears /
    // disappears instantly. Doing the API call before the state update caused
    // two bugs: (a) the reaction only showed after the network round-trip and
    // (b) a remove raced the server's WS "removed" fan-out — the WS handler
    // removed the chip, then the late local toggle re-ADDED it, making
    // "remove reaction" appear broken.
    const applyToggle = (prev: ChatMessage[]) =>
      prev.map((m) => {
        if (m.id !== message.id) return m;
        if (m.deleted_at) return { ...m, reactions: [] };
        const existing = m.reactions || [];
        const mineIdx = existing.findIndex(
          (r) => r.userId === user?.id && r.emoji === emoji,
        );
        if (mineIdx >= 0) {
          return { ...m, reactions: existing.filter((_, i) => i !== mineIdx) };
        }
        return {
          ...m,
          reactions: [
            ...existing,
            { emoji, userId: user?.id ?? 0, fullName: user?.full_name ?? "" },
          ],
        };
      });
    setMessages(applyToggle);
    // Haptic + subtle sound on ADD (Signal parity).
    if (willAdd) {
      try {
        Vibration.vibrate(12);
      } catch {
        /* no-op */
      }
      playReactionSound();
    }
    try {
      await toggleReaction(message.id, emoji);
    } catch {
      // API failed — revert the optimistic toggle so UI matches the server.
      setMessages(applyToggle);
    }
  }

  function pickEmoji(emoji: string) {
    if (emojiMode === "compose") {
      setText((t) => t + emoji);
    } else if (reactTarget) {
      // Apply the chosen reaction to the long-pressed message. `react()` clears
      // reactTarget itself, but clear the anchor too so the reaction overlay
      // doesn't briefly re-appear behind the closing picker.
      react(reactTarget, emoji);
      setReactAnchor(null);
    }
    setShowAllEmoji(false);
  }

  // Close the full emoji picker WITHOUT picking. In "react" mode this must also
  // drop the long-pressed target/anchor, otherwise the reaction overlay (which
  // is hidden only while the picker is open) would pop straight back up.
  function closeEmojiPicker() {
    setShowAllEmoji(false);
    if (emojiMode === "react") {
      setReactTarget(null);
      setReactAnchor(null);
    }
  }

  // Enter multi-select mode seeded with one message (the long-press context
  // menu's "Select" action). Closes the context menu first so the header can
  // cleanly swap to the selection action bar.
  function enterSelectionWith(message: ChatMessage) {
    setReactTarget(null);
    setReactAnchor(null);
    selectOnly(message);
  }

  // Anchor the reaction/context menu to the long-pressed bubble (mirrors the
  // web MessageBubble). Measures the bubble's host node directly for
  // reliability.
  //
  // IMPORTANT (UX fix): long-press NO LONGER enters multi-select mode. Doing
  // both at once tangled "react to this message" with "select messages" — the
  // reaction pill AND the header selection action bar appeared together, which
  // felt broken. Now long-press opens ONE cohesive context menu (reaction pill
  // + per-message actions). Multi-select is an explicit "Select" action inside
  // that menu (Signal / WhatsApp / Telegram model).
  function openReactionBar(item: ChatMessage, mine: boolean) {
    // Already selecting? Long-press just toggles this row in the selection
    // (Signal/WhatsApp): the context menu is a single-message surface, so it
    // shouldn't reappear on top of an active multi-select.
    if (selectedIds.size > 0) {
      toggleSelect(item);
      return;
    }
    // Crisp haptic the instant the menu opens (Signal-Android fires a
    // performHapticFeedback(LONG_PRESS) on long-press before the overlay
    // animates in). LONG_PRESS is a single short, firm tick — a ~20ms pulse
    // reads closer to it than the previous 12ms blip.
    try {
      Vibration.vibrate(20);
    } catch {
      /* no-op */
    }
    const node = bubbleRefs.current.get(item.id) as unknown as {
      measureInWindow?: (
        cb: (x: number, y: number, width: number, height: number) => void,
      ) => void;
    } | null;
    // IMPORTANT: call measureInWindow ON the node (not via a detached
    // reference). It is a method bound to the native view instance — invoking
    // it without its receiver loses `this` and crashes the app natively.
    if (node && typeof node.measureInWindow === "function") {
      try {
        node.measureInWindow((x, y, width, height) => {
          setReactAnchor({ x, y, width, height, mine });
          setReactTarget(item);
        });
      } catch {
        setReactAnchor(null);
        setReactTarget(item);
      }
    } else {
      setReactAnchor(null);
      setReactTarget(item);
    }
  }

  // Position the reaction bar right next to the long-pressed bubble (mirrors
  // the web MessageBubble behavior). Falls back to centered if no anchor.
  function computeBarPosition() {
    if (!reactAnchor) {
      return {
        position: "absolute" as const,
        top: windowHeight / 2 - barSize.height / 2,
        left: windowWidth / 2 - barSize.width / 2,
      };
    }
    const margin = 8;
    const gap = 6;
    const barW = barSize.width || 300;
    const barH = barSize.height || 44;

    // Horizontal: align with the bubble edge, clamped to the screen.
    let left = reactAnchor.mine
      ? reactAnchor.x + reactAnchor.width - barW
      : reactAnchor.x;
    left = Math.max(margin, Math.min(left, windowWidth - barW - margin));

    // Vertical: prefer above the bubble; if it doesn't fit, place below.
    let top = reactAnchor.y - barH - gap;
    if (top < insetTop + margin) {
      top = reactAnchor.y + reactAnchor.height + gap;
    }
    top = Math.max(insetTop + margin, Math.min(top, windowHeight - barH - margin));

    return { position: "absolute" as const, top, left };
  }

  // Reaction-bar size measurement (keeps the anchor positioning accurate).
  function onReactionBarLayout(width: number, height: number) {
    if (
      Math.abs(width - barSize.width) > 1 ||
      Math.abs(height - barSize.height) > 1
    ) {
      setBarSize({ width, height });
    }
  }

  return {
    reactTarget,
    setReactTarget,
    reactAnchor,
    setReactAnchor,
    actionTarget,
    setActionTarget,
    showAllEmoji,
    setShowAllEmoji,
    emojiMode,
    setEmojiMode,
    registerBubbleRef,
    react,
    pickEmoji,
    closeEmojiPicker,
    enterSelectionWith,
    openReactionBar,
    computeBarPosition,
    onReactionBarLayout,
  };
}
