export interface ChatReaction {
  emoji: string;
  userId: string;
  userName?: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  body: string | null;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  readAt?: string | null;
  deliveredAt?: string | null;
  clientNonce?: string | null;
  reactions?: ChatReaction[];
  attachments?: ChatAttachment[];
}