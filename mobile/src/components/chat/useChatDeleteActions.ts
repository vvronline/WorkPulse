import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useDialog } from "../../hooks/useDialog";
import { deleteMessage, type ChatMessage } from "../../features";
import { addLocalDeletedIds } from "../../storage/chatLocalDeletes";
import type { ReactionAnchor } from "./useChatMessageContextMenu";

type ThreadUser = ReturnType<typeof useAuth>["user"];

type UseChatDeleteActionsOptions = {
  convId: number;
  user: ThreadUser;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setLocallyDeleted: Dispatch<SetStateAction<Set<number>>>;
  setReactTarget: Dispatch<SetStateAction<ChatMessage | null>>;
  setReactAnchor: Dispatch<SetStateAction<ReactionAnchor | null>>;
  setActionTarget: Dispatch<SetStateAction<ChatMessage | null>>;
  selectedMessages: ChatMessage[];
  clearSelection: () => void;
  alert: ReturnType<typeof useDialog>["alert"];
};

/**
 * Delete (WhatsApp/Telegram/Signal model).
 *
 * A single chooser drives BOTH single-message deletes (long-press menu) and
 * multi-select deletes (header trash). `deleteTargets` holds the messages the
 * open chooser operates on; the chooser offers "Delete for everyone" (own
 * messages only — the server rejects deleting others') and "Delete for me"
 * (a local-only hide, persisted per device).
 */
export default function useChatDeleteActions({
  convId,
  user,
  setMessages,
  setLocallyDeleted,
  setReactTarget,
  setReactAnchor,
  setActionTarget,
  selectedMessages,
  clearSelection,
  alert,
}: UseChatDeleteActionsOptions) {
  const [deleteTargets, setDeleteTargets] = useState<ChatMessage[] | null>(
    null,
  );
  const deleteCanForEveryone = useMemo(
    () =>
      !!deleteTargets &&
      deleteTargets.length > 0 &&
      deleteTargets.every((m) => Number(m.sender_id) === Number(user?.id)),
    [deleteTargets, user?.id],
  );

  // Open the delete chooser. Dismisses the long-press surfaces first, then opens
  // the sheet on a short delay so the dismissing Modal never collides with it
  // (same pattern the old confirm flow used).
  function requestDelete(targets: (ChatMessage | null | undefined)[]) {
    setReactTarget(null);
    setReactAnchor(null);
    setActionTarget(null);
    const list = targets.filter(Boolean) as ChatMessage[];
    if (list.length === 0) return;
    setTimeout(() => setDeleteTargets(list), 250);
  }

  function doDelete(message: ChatMessage) {
    // Open the delete chooser for this single message (WhatsApp/Telegram/Signal
    // model). The chooser offers "Delete for everyone" (own messages only) and
    // "Delete for me" (local hide). Replaces the old immediate delete-for-
    // everyone confirm.
    requestDelete([message]);
  }

  function closeDeleteSheet() {
    setDeleteTargets(null);
  }

  // "Delete for everyone" — calls the server for each OWN target and marks it
  // deleted locally (the peer gets a chat_delete socket event).
  function deleteForEveryone() {
    const targets = (deleteTargets || []).filter(
      (m) => Number(m.sender_id) === Number(user?.id),
    );
    setDeleteTargets(null);
    if (targets.length === 0) return;
    Promise.all(
      targets.map((m) =>
        deleteMessage(m.id)
          .then(() =>
            setMessages((prev) =>
              prev.map((x) =>
                x.id === m.id
                  ? {
                      ...x,
                      deleted_at: new Date().toISOString(),
                      content: "",
                      file_url: null,
                      file_name: null,
                      file_type: null,
                      file_size: null,
                      reactions: [],
                    }
                  : x,
              ),
            ),
          )
          .catch(() => {}),
      ),
    ).catch(() => alert("Error", "Could not delete message(s)."));
  }

  // "Delete for me" — hides the target message(s) on this device only and
  // persists the hidden ids so they stay hidden across reloads.
  function deleteForMe() {
    const targets = deleteTargets || [];
    setDeleteTargets(null);
    if (targets.length === 0) return;
    const ids = targets.map((m) => Number(m.id));
    setLocallyDeleted((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    addLocalDeletedIds(convId, ids);
  }

  // Delete every selected message (header delete icon). Opens the chooser for
  // the whole selection — "Delete for everyone" applies to the own messages in
  // it, "Delete for me" hides them all locally (so a mixed mine/theirs
  // selection still has a working delete, which it previously lacked).
  function deleteSelected() {
    const targets = [...selectedMessages];
    clearSelection();
    requestDelete(targets);
  }

  return {
    deleteTargets,
    deleteCanForEveryone,
    requestDelete,
    doDelete,
    closeDeleteSheet,
    deleteForEveryone,
    deleteForMe,
    deleteSelected,
  };
}
