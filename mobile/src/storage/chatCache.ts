import { storage } from './mmkv';
import type { ChatMessage } from '../types/chat';

const THREAD_PREFIX = 'chat:thread:';
const CONVERSATIONS_KEY = 'chat:conversations';
const MAX_CACHED_MESSAGES = 50;

interface CachedConversation {
  id: string;
  peerId?: string;
  peerName?: string;
  peerAvatar?: string;
  peerTitle?: string;
  lastMessage?: string;
  lastMessageAt?: string;
  unreadCount?: number;
}

export async function getCachedThread(conversationId: string): Promise<ChatMessage[] | null> {
  const raw = storage.getString(`${THREAD_PREFIX}${conversationId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChatMessage[];
  } catch {
    return null;
  }
}

export async function setCachedThread(
  conversationId: string,
  messages: ChatMessage[] | undefined,
): Promise<void> {
  if (!messages) {
    storage.remove(`${THREAD_PREFIX}${conversationId}`);
    return;
  }
  const trimmed = messages.slice(0, MAX_CACHED_MESSAGES);
  storage.set(`${THREAD_PREFIX}${conversationId}`, JSON.stringify(trimmed));
}

export async function getCachedConversations(): Promise<CachedConversation[] | null> {
  const raw = storage.getString(CONVERSATIONS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedConversation[];
  } catch {
    return null;
  }
}

export async function setCachedConversations(
  conversations: CachedConversation[],
): Promise<void> {
  storage.set(CONVERSATIONS_KEY, JSON.stringify(conversations));
}