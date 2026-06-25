import notifee, {
  AndroidImportance,
  AndroidStyle,
  AndroidVisibility,
  AndroidCategory,
  AndroidNotificationSetting,
  EventType,
  type Notification,
} from '@notifee/react-native';
import { Linking, Platform } from 'react-native';
import { router } from 'expo-router';
import { fetchWithAuth } from '../api/http';
import { SERVER_ORIGIN } from '../config';

export const ANDROID_CHANNELS = {
  messages: {
    id: 'messages',
    name: 'Messages',
    importance: AndroidImportance.HIGH,
  },
  calls: {
    id: 'calls',
    name: 'Calls',
    importance: AndroidImportance.HIGH,
  },
} as const;

let channelsCreated = false;

export async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (channelsCreated) return;

  await notifee.createChannel({
    id: ANDROID_CHANNELS.messages.id,
    name: ANDROID_CHANNELS.messages.name,
    importance: ANDROID_CHANNELS.messages.importance,
    sound: 'default',
    vibration: true,
  });

  await notifee.createChannel({
    id: ANDROID_CHANNELS.calls.id,
    name: ANDROID_CHANNELS.calls.name,
    importance: ANDROID_CHANNELS.calls.importance,
    sound: 'default',
    vibration: true,
    bypassDnd: true,
  });

  channelsCreated = true;
}

interface ChatMessageData {
  type?: string;
  conversationId: string;
  senderName?: string;
  senderAvatar?: string;
  preview?: string;
}

function buildMessageNotification(data: ChatMessageData): Notification {
  const title = data.senderName || 'New message';
  const body = data.preview || 'You have a new message';

  return {
    id: `chat-${data.conversationId}`,
    title,
    body,
    data: {
      type: 'chat',
      conversationId: data.conversationId,
      // Persist sender identity on the notification so we can pass it straight
      // to the chat screen when the notification is pressed (even on cold start).
      ...(data.senderName ? { senderName: data.senderName } : {}),
      ...(data.senderAvatar ? { senderAvatar: data.senderAvatar } : {}),
    },
    android: {
      channelId: ANDROID_CHANNELS.messages.id,
      importance: AndroidImportance.HIGH,
      category: AndroidCategory.MESSAGE,
      visibility: AndroidVisibility.PRIVATE,
      pressAction: {
        id: 'default',
        launchActivity: 'default',
      },
      smallIcon: 'ic_notification',
      timestamp: Date.now(),
      showTimestamp: true,
      actions: [
        {
          title: 'Reply',
          pressAction: { id: 'reply' },
          input: {
            allowFreeFormInput: true,
            placeholder: 'Type a reply...',
          },
        },
        {
          title: 'Mark as read',
          pressAction: { id: 'mark-read' },
        },
      ],
    },
    ios: {
      categoryId: 'message',
      threadId: data.conversationId,
    },
  };
}

export async function displayMessageNotification(data: ChatMessageData): Promise<void> {
  await ensureChannels();
  const notification = buildMessageNotification(data);
  await notifee.displayNotification(notification);
}

export function setupNotifeeForegroundHandler(): () => void {
  return notifee.onForegroundEvent(async ({ type, detail }) => {
    await handleNotifeeEvent(type, detail);
  });
}

function openConversation(data: ChatMessageData): void {
  router.push({
    pathname: `/chat/${data.conversationId}`,
    params: {
      ...(data.senderName ? { name: data.senderName } : {}),
      ...(data.senderAvatar ? { avatar: data.senderAvatar } : {}),
    },
  });
}

/**
 * Handles the notification that launched the app from a killed/background state.
 * Should be called once at app startup so the chat screen receives the sender
 * name/avatar params instead of falling back to "Chat" / "?".
 */
export async function handleInitialNotification(): Promise<void> {
  try {
    const initial = await notifee.getInitialNotification();
    const data = initial?.notification?.data as unknown as ChatMessageData | undefined;
    if (initial && data?.conversationId && data?.type === 'chat') {
      openConversation(data);
    }
  } catch (err) {
    console.warn('[notifee] initial notification failed', err);
  }
}

async function handleNotifeeEvent(
  type: EventType,
  detail: { notification?: Notification; pressAction?: { id: string }; input?: string },
): Promise<void> {
  const { notification, pressAction, input } = detail;
  if (!notification) return;

  const data = notification.data as unknown as ChatMessageData | undefined;
  const conversationId = data?.conversationId;

  if (type === EventType.ACTION_PRESS) {
    if (pressAction?.id === 'reply' && input && conversationId) {
      await sendReplyFromNotification(conversationId, input);
      return;
    }
    if (pressAction?.id === 'mark-read' && conversationId) {
      await markConversationRead(conversationId);
      return;
    }
  }

  if (type === EventType.PRESS && conversationId && data) {
    openConversation(data);
  }
}

async function sendReplyFromNotification(conversationId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    const res = await fetchWithAuth(
      `${SERVER_ORIGIN}/api/chat/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      },
    );
    if (!res.ok) {
      throw new Error(`Reply failed: ${res.status}`);
    }
  } catch (err) {
    console.warn('[notifee] reply failed', err);
  }
}

async function markConversationRead(conversationId: string): Promise<void> {
  try {
    await fetchWithAuth(
      `${SERVER_ORIGIN}/api/chat/conversations/${conversationId}/messages/read`,
      {
        method: 'POST',
      },
    );
  } catch (err) {
    console.warn('[notifee] mark read failed', err);
  }
}

export { handleNotifeeEvent };

/**
 * Requests POST_NOTIFICATIONS (Android 13+) / iOS notification permission via
 * Notifee. Expo's permission alone is not enough for Notifee-rendered data
 * pushes on Android 13+.
 */
export async function requestNotificationPermission(): Promise<void> {
  try {
    await notifee.requestPermission();
  } catch (err) {
    console.warn('[notifee] requestPermission failed', err);
  }
}

/**
 * Ensures the Android 14+ full-screen-intent permission so the incoming-call
 * screen can surface over the lock screen. If it isn't granted yet, deep-links
 * the user to the system settings page to grant it (best-effort).
 */
export async function ensureFullScreenIntentPermission(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const settings = await notifee.getNotificationSettings();
    // On Android 14+ the full-screen-intent permission is surfaced via the
    // `alarm` setting. If it isn't enabled, deep-link the user to settings so
    // the incoming-call screen can surface over the lock screen (best-effort).
    if (settings.android?.alarm === AndroidNotificationSetting.DISABLED) {
      await Linking.openSettings().catch(() => {});
    }
  } catch (err) {
    console.warn('[notifee] ensureFullScreenIntentPermission failed', err);
  }
}

/**
 * Aggregated service object so callers can use a single, stable import
 * (`notifeeService.*`) rather than many individual named imports.
 */
export const notifeeService = {
  ensureChannels,
  displayMessageNotification,
  registerForegroundHandler: setupNotifeeForegroundHandler,
  handleInitialNotification,
  handleNotifeeEvent,
  requestNotificationPermission,
  ensureFullScreenIntentPermission,
};
