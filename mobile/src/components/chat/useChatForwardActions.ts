import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useDialog } from "../../hooks/useDialog";
import {
  forwardMessage,
  getConversations,
  type ChatMessage,
  type Conversation,
} from "../../features";
import type { ReactionAnchor } from "./useChatMessageContextMenu";

type UseChatForwardActionsOptions = {
  actionTarget: ChatMessage | null;
  setActionTarget: Dispatch<SetStateAction<ChatMessage | null>>;
  setReactTarget: Dispatch<SetStateAction<ChatMessage | null>>;
  setReactAnchor: Dispatch<SetStateAction<ReactionAnchor | null>>;
  selectedMessages: ChatMessage[];
  clearSelection: () => void;
  alert: ReturnType<typeof useDialog>["alert"];
};

/**
 * The action sheet's "Forward to…" mode plus the conversation picker it feeds.
 *
 * Forward used to live in a separate <Modal> opened via setTimeout after
 * dismissing the action sheet — on Android presenting a modal while another is
 * dismissing silently fails, which is why Forward appeared broken. A single
 * modal with switching content has no such race, so this hook only toggles the
 * mode of the already-open sheet.
 */
export default function useChatForwardActions({
  actionTarget,
  setActionTarget,
  setReactTarget,
  setReactAnchor,
  selectedMessages,
  clearSelection,
  alert,
}: UseChatForwardActionsOptions) {
  // When true, the action-sheet modal shows the "Forward to…" conversation
  // picker INSTEAD of the action rows.
  const [forwardMode, setForwardMode] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Forward every selected message (header forward icon). Promotes the
  // selection to `forwardSelection` and opens the forward picker; the actual
  // fan-out happens in doForward (which loops the API per selected id).
  const [forwardSelection, setForwardSelection] = useState<ChatMessage[]>([]);

  // Open the Forward picker for a message reached from the reaction overlay.
  // The overlay's target lives in `reactTarget`; we promote it to
  // `actionTarget` (which drives the forward picker modal + doForward) and
  // switch into forward mode.
  function openForwardFor(message: ChatMessage) {
    setReactTarget(null);
    setReactAnchor(null);
    setActionTarget(message);
    getConversations()
      .then((r) => setConversations(r.data || []))
      .catch(() => setConversations([]));
    setForwardMode(true);
  }

  function openForward() {
    // Switch the already-open action-sheet modal into "forward" mode. We do
    // NOT dismiss this modal and present another — that cross-modal race on
    // Android is what made Forward silently fail before.
    setReactTarget(null);
    // Preload conversations so the picker isn't empty when it appears.
    getConversations()
      .then((r) => setConversations(r.data || []))
      .catch(() => setConversations([]));
    setForwardMode(true);
  }

  function closeActionSheet() {
    setActionTarget(null);
    setForwardMode(false);
    setForwardSelection([]);
  }

  function doForward(targetConvId: number) {
    // Multi-select forward: if a selection was promoted to `forwardSelection`,
    // fan the forward out across every selected message id. Otherwise fall back
    // to the single `actionTarget` (reaction-overlay / action-sheet path).
    const targets =
      forwardSelection.length > 0
        ? forwardSelection
        : actionTarget
          ? [actionTarget]
          : [];
    if (targets.length === 0) return;
    closeActionSheet();
    clearSelection();
    Promise.all(targets.map((m) => forwardMessage(m.id, [targetConvId])))
      .then(() => {
        // Small defer so the result dialog never collides with the
        // dismissing modal.
        setTimeout(
          () =>
            alert(
              "Forwarded",
              targets.length > 1
                ? `${targets.length} messages forwarded.`
                : "Message forwarded.",
            ),
          300,
        );
      })
      .catch((e: any) => {
        setTimeout(
          () =>
            alert(
              "Error",
              e?.response?.data?.error || "Could not forward message.",
            ),
          300,
        );
      });
  }

  function forwardSelected() {
    const targets = [...selectedMessages];
    if (targets.length === 0) return;
    setForwardSelection(targets);
    setActionTarget(targets[0]);
    getConversations()
      .then((r) => setConversations(r.data || []))
      .catch(() => setConversations([]));
    setForwardMode(true);
  }

  return {
    forwardMode,
    conversations,
    openForward,
    openForwardFor,
    closeActionSheet,
    doForward,
    forwardSelected,
  };
}
