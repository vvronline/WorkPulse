import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

export type EnsureConversationOptions = {
  conversationId: string;
  title: string;
  senderId?: string;
  senderName?: string;
  avatarUri?: string;
  parentChannelId: string;
};

export type ConversationNotificationMetadata = {
  shortcutId: string;
  channelId: string;
};

type ConversationNotificationsNativeModule = {
  ensureConversation(
    options: Record<string, string>,
  ): Promise<ConversationNotificationMetadata | null>;
};

const ConversationNotifications =
  requireOptionalNativeModule<ConversationNotificationsNativeModule>(
    "ConversationNotifications",
  );

/**
 * Registers/updates Android's native conversation identity and returns the
 * matching shortcut + child-channel IDs. Returns null on unsupported platforms,
 * Expo Go, stale native builds, or any native failure so callers can safely use
 * their normal message channel.
 */
export async function ensureAndroidConversation(
  options: EnsureConversationOptions,
): Promise<ConversationNotificationMetadata | null> {
  if (
    Platform.OS !== "android" ||
    !ConversationNotifications ||
    !options.conversationId ||
    !options.parentChannelId
  ) {
    return null;
  }

  try {
    const result = await ConversationNotifications.ensureConversation({
      conversationId: options.conversationId,
      title: options.title || options.senderName || "Conversation",
      senderId: options.senderId || "",
      senderName: options.senderName || options.title || "Conversation",
      avatarUri: options.avatarUri || "",
      parentChannelId: options.parentChannelId,
    });

    if (
      result &&
      typeof result.shortcutId === "string" &&
      result.shortcutId.length > 0 &&
      typeof result.channelId === "string" &&
      result.channelId.length > 0
    ) {
      return result;
    }
  } catch {
    // Conversation promotion is optional. Notification delivery must continue.
  }

  return null;
}

export const isConversationNotificationsAvailable =
  Platform.OS === "android" && ConversationNotifications != null;