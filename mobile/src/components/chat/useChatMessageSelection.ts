import { useCallback, useMemo, useState } from "react";

type IdentifiedMessage = {
  id: number;
  sender_id?: number | null;
};

type UseChatMessageSelectionResult<Message extends IdentifiedMessage> = {
  selectedIds: Set<number>;
  selectedMessages: Message[];
  selectionMode: boolean;
  selectionAllOwn: boolean;
  selectedCount: number;
  clearSelection: () => void;
  toggleSelect: (message: Message) => void;
  selectOnly: (message: Message) => void;
};

/**
 * Cohesive selection state for message multi-actions.
 *
 * Derived message arrays and ownership checks are memoized here so the thread
 * coordinator only orchestrates API actions and modal transitions.
 */
export default function useChatMessageSelection<
  Message extends IdentifiedMessage,
>(
  messages: Message[],
  currentUserId: number | null | undefined,
): UseChatMessageSelectionResult<Message> {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((message: Message) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(message.id)) next.delete(message.id);
      else next.add(message.id);
      return next;
    });
  }, []);

  const selectOnly = useCallback((message: Message) => {
    setSelectedIds(new Set([message.id]));
  }, []);

  const selectedMessages = useMemo(
    () => messages.filter((message) => selectedIds.has(message.id)),
    [messages, selectedIds],
  );

  const selectionAllOwn = useMemo(
    () =>
      selectedMessages.length > 0 &&
      selectedMessages.every(
        (message) =>
          Number(message.sender_id) === Number(currentUserId),
      ),
    [currentUserId, selectedMessages],
  );

  return {
    selectedIds,
    selectedMessages,
    selectionMode: selectedIds.size > 0,
    selectionAllOwn,
    selectedCount: selectedIds.size,
    clearSelection,
    toggleSelect,
    selectOnly,
  };
}