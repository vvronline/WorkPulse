/**
 * Runtime identity boundary for synchronous MMKV chat persistence.
 *
 * Conversation IDs are only unique within a tenant database. Every cache,
 * local-delete marker, and offline-outbox entry must therefore be scoped by
 * the active tenant and user before it can be read on a shared device.
 */
let activeScope: string | null = null;

export type ChatStorageIdentity = {
  id: number;
  tenant_id?: number | null;
};

/** Activate the namespace for the authenticated identity. */
export function setChatStorageScope(user: ChatStorageIdentity): void {
  activeScope = `tenant:${user.tenant_id ?? "platform"}:user:${user.id}`;
}

/** Clear the namespace when the session is removed or becomes untrusted. */
export function clearChatStorageScope(): void {
  activeScope = null;
}

/**
 * Returns a fully namespaced key, or null when no authenticated scope exists.
 * Callers must treat null as an empty cache rather than falling back to an
 * unscoped legacy key.
 */
export function scopedChatStorageKey(suffix: string): string | null {
  return activeScope ? `chat:v2:${activeScope}:${suffix}` : null;
}

/** Useful for scoped cleanup while keeping non-chat MMKV data untouched. */
export function activeChatStoragePrefix(): string | null {
  return activeScope ? `chat:v2:${activeScope}:` : null;
}