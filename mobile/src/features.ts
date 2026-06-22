import { api } from "./api";

/* ───────────────────────── Tasks ───────────────────────── */

export type TaskStatus = "pending" | "in_progress" | "in_review" | "done";
export type TaskPriority = "low" | "medium" | "high";

export type TaskAssignee = {
  id: number;
  full_name?: string;
  username?: string;
  avatar?: string | null;
};

export type Task = {
  id: number;
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  issue_key?: string | null;
  // `date` is the daily-planner schedule date (YYYY-MM-DD). A task is in the
  // backlog when both `date` and `sprint_id` are null. `due_date` is a
  // separate target/deadline field — do NOT use it to infer scheduled state.
  date?: string | null;
  due_date?: string | null;
  sprint_id?: number | null;
  // Agile / card metadata (mirrors the web ticket card)
  story_points?: number | string | null;
  work_item_type_id?: number | string | null;
  is_blocked?: boolean;
  blocked_reason?: string | null;
  comment_count?: number;
  assigned_to?: number | null;
  assignee?: TaskAssignee | null;
  labels?: TaskLabel[];
};

export type TaskStats = {
  total: number;
  done: number;
  inProgress: number;
  percent: number;
};

export function getTasks(params?: Record<string, string>) {
  return api.get<{ tasks: Task[]; stats: TaskStats }>("/tasks", { params });
}

export function updateTaskStatus(id: number, status: TaskStatus) {
  return api.patch(`/tasks/${id}/status`, { status });
}

export function updateTaskFull(
  id: number,
  data: {
    title?: string;
    description?: string;
    priority?: TaskPriority;
    assigned_to?: number | null;
    due_date?: string | null;
    sprint_id?: number | null;
    label_ids?: number[];
    story_points?: number | string | null;
    work_item_type_id?: number | string | null;
    project_id?: number | string | null;
  },
) {
  return api.put<Task>(`/tasks/${id}`, data);
}

export function deleteTask(id: number) {
  return api.delete(`/tasks/${id}`);
}

export type TaskComment = {
  id: number;
  user_id: number;
  full_name?: string;
  username?: string;
  content: string;
  created_at: string;
  // File attachment (mirrors the web client + chat message shape). A comment
  // may carry text, a single file, or both.
  file_url?: string | null;
  file_name?: string | null;
  file_type?: string | null;
  file_size?: number | null;
};

// Map common extensions to the MIME types the server's task-comment upload
// fileFilter allows (see server/routes/tasks/comments.ts ALLOWED_TYPES).
const COMMENT_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
};

export type CommentAttachment = {
  uri: string;
  name?: string;
  mimeType?: string;
};

export function addTaskComment(
  id: number,
  content: string,
  file?: CommentAttachment | null,
) {
  // When a file is attached we must send multipart/form-data so multer's
  // `single('file')` middleware can parse it (matches the web client + chat
  // upload). The React Native FormData file shape is { uri, name, type }.
  if (file?.uri) {
    const name = file.name || file.uri.split("/").pop() || "file";
    const match = /\.(\w+)$/.exec(name);
    const ext = (match?.[1] || "").toLowerCase();
    const mime =
      file.mimeType || COMMENT_MIME_BY_EXT[ext] || "application/octet-stream";
    const form = new FormData();
    if (content) form.append("content", content);
    form.append("file", { uri: file.uri, name, type: mime } as any);
    return api.post<TaskComment>(`/tasks/${id}/comments`, form, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  }

  // The server's POST /tasks/:id/comments route runs through a multer
  // `single('file')` middleware, but multer only consumes multipart bodies and
  // transparently passes JSON bodies through to the handler (which reads
  // `req.body.content`). On React Native, manually setting the
  // `Content-Type: multipart/form-data` header WITHOUT the auto-generated
  // boundary makes multer unable to parse the body → `content` arrives empty
  // and the request fails with "Comment cannot be empty". For a text-only
  // comment we therefore send a plain JSON body, exactly like the web client
  // does when no file is attached (client/src/api.ts addTaskComment).
  return api.post<TaskComment>(`/tasks/${id}/comments`, { content });
}

export type BacklogSummary = {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
};

export function getBacklog(params?: Record<string, string>) {
  return api.get<{
    tasks: Task[];
    summary: BacklogSummary;
    pagination: { limit: number; offset: number; total: number; hasMore: boolean };
  }>("/tasks/backlog", { params });
}

export function addBacklogTask(data: {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assigned_to?: number | null;
  due_date?: string | null;
  label_ids?: number[];
  story_points?: number | string | null;
  sprint_id?: number | null;
  work_item_type_id?: number | string | null;
}) {
  return api.post<Task>("/tasks/backlog", data);
}

export type Sprint = {
  id: number;
  name: string;
  start_date?: string;
  end_date?: string;
  status: "planned" | "active" | "completed";
  goal?: string | null;
  team_id?: number | null;
  team_name?: string | null;
};

export function getAvailableSprints() {
  return api.get<Sprint[]>("/tasks/available-sprints");
}

export function getSprintTasks(sprintId: number) {
  return api.get<{ tasks: Task[]; stats: TaskStats }>("/tasks", {
    params: { sprint_id: String(sprintId) },
  });
}

/* ───────────────────────── Agile config (workflow states) ───────────────────────── */

export type WorkflowState = {
  id: number;
  key?: string;
  name: string;
  color?: string;
  is_initial?: boolean;
  is_final?: boolean;
  wip_limit?: number | null;
  order_index?: number;
};

export type WorkItemType = {
  id: number | string;
  key: string;
  name: string;
  color?: string;
  icon?: string;
  is_default?: boolean;
  is_epic?: boolean;
  sort_order?: number;
};

export type AgileSettings = {
  estimation_type?: string;
  estimation_values?: (number | string)[] | string | null;
  estimation_unit_label?: string | null;
  enable_story_points?: boolean;
  [k: string]: unknown;
};

export type AgileConfig = {
  settings?: AgileSettings;
  workflowStates: WorkflowState[];
  workItemTypes?: WorkItemType[];
  features?: { wipLimits?: boolean; storyPoints?: boolean; [k: string]: unknown };
  canEdit?: boolean;
};

export function getAgileConfig() {
  return api.get<AgileConfig>("/agile/config");
}

/* ───────────────────────── Leaves ───────────────────────── */

export type LeaveBalance = {
  leave_type: string;
  policy_name?: string;
  color?: string;
  quota: number;
  used: number;
  carried_forward: number;
  year: number;
};

export type Leave = {
  id: number;
  leave_type: string;
  date: string;
  duration: string;
  reason?: string | null;
  status: "pending" | "approved" | "rejected" | "withdraw_pending" | "withdrawn";
};

export function getLeaveBalance(year?: number) {
  return api.get<LeaveBalance[]>("/leaves/balance", {
    params: year ? { year: String(year) } : undefined,
  });
}

export function getLeaves(startDate?: string, endDate?: string) {
  return api.get<Leave[]>("/leaves", {
    params: { start_date: startDate, end_date: endDate },
  });
}

export type LeavePolicy = {
  id: number;
  leave_type: string;
  name?: string | null;
  color?: string | null;
  annual_quota?: number | string;
  accrual_type?: string | null;
  carry_forward_limit?: number | string | null;
  half_day_allowed?: boolean;
  quarter_day_allowed?: boolean;
};

export function getLeavePolicies() {
  return api.get<LeavePolicy[]>("/leave-policy/policies");
}

export function saveLeavePolicy(data: {
  leave_type?: string;
  name?: string;
  color?: string;
  annual_quota?: number;
  accrual_type?: string;
  carry_forward_limit?: number;
  half_day_allowed?: boolean | number;
  quarter_day_allowed?: boolean | number;
}) {
  return api.post("/leave-policy/policies", data);
}

export function deleteLeavePolicy(id: number | string) {
  return api.delete(`/leave-policy/policies/${id}`);
}

/** Public holidays for a year (used to colour the attendance calendar). */
export type Holiday = {
  id: number;
  name?: string | null;
  date: string;
};

export function getHolidays(year?: number) {
  return api.get<Holiday[]>("/leave-policy/holidays", {
    params: year ? { year: String(year) } : undefined,
  });
}

/**
 * HR-only: all employees' leave balances. Pass year "all" (string) to retrieve
 * every employee row across the org (mirrors the web AllBalances view).
 */
export type AllBalanceRow = {
  user_id?: number | string;
  policy_id?: number | string;
  full_name?: string;
  leave_type?: string;
  total_days?: number;
  used?: number;
  balance?: number;
  carried_forward?: number;
  quota?: number;
  year?: number | string;
};

export function getAllLeaveBalances(year: number | "all" = "all") {
  return api.get<AllBalanceRow[]>("/leave-policy/balances", {
    params: { year: String(year) },
  });
}

export function updateLeaveBalance(
  userId: number | string,
  data: {
    policy_id?: number | string;
    year?: number | string;
    total_days?: number;
    used?: number;
    carried_forward?: number;
  },
) {
  return api.put(`/leave-policy/balances/${userId}`, data);
}

// Withdraw a pending or approved leave. Pending leaves are cancelled outright;
// approved leaves create a withdrawal-approval request for the manager.
export function withdrawLeave(id: number | string) {
  return api.post(`/leaves/${id}/withdraw`);
}

// Apply for one or more leaves. The server's POST /leaves accepts a `dates`
// array (multi-day) and shares the same endpoint for single-day requests.
export function addLeavesBatch(data: {
  dates: string[];
  leave_type: string;
  duration?: "full" | "half" | "quarter";
  reason?: string;
}) {
  return api.post("/leaves", data);
}

/* ──────────────────────── Notifications ──────────────────── */

export type Notification = {
  id: number;
  type: string;
  title: string;
  body?: string | null;
  is_read: boolean;
  created_at: string;
  task_title?: string | null;
};

export function getNotifications() {
  return api.get<{
    notifications: Notification[];
    unread: number;
    total: number;
  }>("/notifications");
}

export function markNotificationRead(id: number) {
  return api.post(`/notifications/${id}/read`);
}

export function markAllNotificationsRead() {
  return api.post("/notifications/read-all");
}

/* ───────────────────────── Chat ───────────────────────── */

export type Conversation = {
  id: number;
  is_group: boolean;
  group_name?: string | null;
  other_user_id?: number | null;
  other_username?: string | null;
  other_full_name?: string | null;
  other_avatar?: string | null;
  last_message?: string | null;
  last_sender_id?: number | null;
  last_message_at?: string | null;
  last_file_url?: string | null;
  unread_count: number;
  member_count?: number | null;
  is_self_chat?: boolean;
  is_pinned?: boolean;
  is_favourite?: boolean;
  is_meeting_chat?: boolean;
  meeting_code?: string | null;
};

export type CallLogEntry = {
  id: number;
  conversation_id: number;
  caller_id: number;
  caller_name?: string | null;
  caller_avatar?: string | null;
  other_name?: string | null;
  other_avatar?: string | null;
  is_group?: boolean;
  group_name?: string | null;
  call_type: "audio" | "video" | string;
  status: "answered" | "missed" | "rejected" | "ended" | string;
  duration?: number;
  created_at: string;
};

export type IceConfig = {
  iceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  mode?: string;
  expiresAt?: number;
  // P1.9 — whether the client may use its hard-coded public Open Relay TURN
  // fallback. STUN is always allowed; this gates ONLY the public-TURN relay.
  // Absent on older servers → treated as allowed for backwards-compat.
  allowPublicFallback?: boolean;
};

export type ChatReaction = { emoji: string; userId: number; fullName: string };

export type ChatMessage = {
  id: number;
  sender_id: number;
  sender_name?: string;
  sender_avatar?: string | null;
  content: string;
  created_at: string;
  file_url?: string | null;
  file_name?: string | null;
  file_type?: string | null;
  file_size?: number | null;
  deleted_at?: string | null;
  edited_at?: string | null;
  reactions?: ChatReaction[];
  // Delivery / read receipts.
  delivered_to?: (number | string)[];
  // Pin state (server toggles pinned_at; list endpoint returns it).
  pinned_at?: string | null;
  pinned_by?: number | null;
  // Reply-to (server stores reply_to_id; list endpoint returns the quoted
  // snippet fields when a message is a reply).
  reply_to_id?: number | null;
  reply_to_content?: string | null;
  reply_to_sender_name?: string | null;
  // Optimistic/local fields
  _pending?: boolean;
  clientMsgId?: string | null;
};

export function getConversations() {
  return api.get<Conversation[]>("/chat/conversations");
}

export function getMessages(convId: number, before?: number) {
  return api.get<ChatMessage[]>(`/chat/conversations/${convId}/messages`, {
    params: before ? { before: String(before) } : undefined,
  });
}

export function markConversationRead(convId: number) {
  return api.post(`/chat/conversations/${convId}/read`);
}

// Acknowledge delivery of a received message so the sender sees the
// "✓✓ delivered" tick (mirrors web client/src/api.ts ackDelivered).
export function ackDelivered(messageId: number) {
  return api.post(`/chat/messages/${messageId}/delivered`);
}

export function searchChatUsers(q: string) {
  return api.get<
    Array<{ id: number; username: string; full_name: string; avatar?: string | null }>
  >("/chat/search", { params: { q } });
}

// The server responds with { conversationId } (NOT { id }) for both the
// "already exists" and "newly created" paths — see server/routes/chat.ts
// POST /conversations. Reading `data.id` here was why tapping a person in
// chat search showed "Could not open this conversation".
export function startConversation(userId: number) {
  return api.post<{ conversationId: number }>("/chat/conversations", {
    userId,
  });
}

export function toggleReaction(messageId: number, emoji: string) {
  return api.post(`/chat/messages/${messageId}/reactions`, { emoji });
}

/**
 * Bulk presence + resolved effective status for a set of users. Mirrors the
 * web `getPresence` (GET /api/chat/presence?userIds=1,2,3). Response shape:
 *   { [userId]: { presence: 'online'|'offline', userStatus: '<effective>' } }
 */
export type PresenceEntry = { presence: string; userStatus: string };

export function getChatPresence(userIds: number[]) {
  return api.get<Record<string, PresenceEntry>>("/chat/presence", {
    params: { userIds: userIds.join(",") },
  });
}

/* ─── Chat: groups, files, message actions (mirror client/src/api.ts) ─── */

export function createGroupConversation(name: string, userIds: number[]) {
  // Server responds { conversationId } — same contract as startConversation.
  return api.post<{ conversationId: number }>("/chat/conversations/group", {
    name,
    userIds,
  });
}

export function uploadChatFile(
  convId: number,
  uri: string,
  fileName?: string,
  mimeType?: string,
) {
  const name = fileName || uri.split("/").pop() || "file";
  const match = /\.(\w+)$/.exec(name);
  const ext = (match?.[1] || "").toLowerCase();
  // Map common extensions to the MIME types the server's chat upload
  // fileFilter allows (see server/routes/chat.ts ALLOWED_TYPES). Audio
  // (voice notes) MUST be included — otherwise an .m4a recording would fall
  // back to application/octet-stream, which the server rejects and the voice
  // message silently fails to send.
  const MIME_BY_EXT: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    pdf: "application/pdf",
    // Audio (voice messages)
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    aac: "audio/mp4",
    ogg: "audio/ogg",
    wav: "audio/wav",
    webm: "audio/webm",
    // Video
    mp4: "video/mp4",
    mov: "video/quicktime",
    // Documents (mirror the server's allow-list)
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    zip: "application/zip",
  };
  const mime = mimeType || MIME_BY_EXT[ext] || "application/octet-stream";
  const form = new FormData();
  form.append("file", { uri, name, type: mime } as any);
  return api.post<ChatMessage>(`/chat/conversations/${convId}/files`, form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
}

export function editMessage(messageId: number, content: string) {
  return api.put<ChatMessage>(`/chat/messages/${messageId}`, { content });
}

export function deleteMessage(messageId: number) {
  return api.delete(`/chat/messages/${messageId}`);
}

export function pinMessage(messageId: number) {
  return api.post<{ ok: boolean; pinned: boolean }>(
    `/chat/messages/${messageId}/pin`,
  );
}

export type PinnedMessage = {
  id: number;
  sender_id: number;
  content?: string | null;
  created_at: string;
  pinned_at?: string | null;
  pinned_by?: number | null;
  file_url?: string | null;
  file_name?: string | null;
  file_type?: string | null;
  sender_name?: string | null;
  sender_avatar?: string | null;
  pinned_by_name?: string | null;
};

export function getPinnedMessages(convId: number) {
  return api.get<PinnedMessage[]>(`/chat/conversations/${convId}/pinned`);
}

export type ReadStatusRow = {
  user_id: number;
  last_read_at: string;
  full_name?: string | null;
};

export function getReadStatus(convId: number) {
  return api.get<ReadStatusRow[]>(
    `/chat/conversations/${convId}/read-status`,
  );
}

export function starMessage(messageId: number) {
  return api.post(`/chat/messages/${messageId}/star`);
}

/* ─── Chat: search / shared files / saved messages / clear chat ───
 * Mirrors the web ChatHeader 3-dot menu (client/src/api.ts). */

export type MessageSearchResult = {
  id: number;
  conversation_id: number;
  sender_id: number;
  content?: string | null;
  created_at: string;
  file_url?: string | null;
  file_name?: string | null;
  sender_name?: string | null;
  sender_avatar?: string | null;
  group_name?: string | null;
  is_group?: boolean;
};

export function searchMessages(q: string, convId?: number) {
  return api.get<MessageSearchResult[]>("/chat/search-messages", {
    params: { q, ...(convId ? { convId: String(convId) } : {}) },
  });
}

export type SharedFile = {
  id: number;
  file_url: string;
  file_name?: string | null;
  file_type?: string | null;
  file_size?: number | null;
  created_at: string;
  sender_id: number;
  sender_name?: string | null;
  sender_avatar?: string | null;
};

export function getSharedFiles(convId: number) {
  return api.get<SharedFile[]>(`/chat/conversations/${convId}/files`);
}

export type StarredMessage = {
  id: number;
  conversation_id: number;
  sender_id: number;
  content?: string | null;
  created_at: string;
  file_url?: string | null;
  file_name?: string | null;
  file_type?: string | null;
  file_size?: number | null;
  sender_name?: string | null;
  sender_avatar?: string | null;
  starred_at?: string | null;
  group_name?: string | null;
  is_group?: boolean;
};

export function getStarredMessages() {
  return api.get<StarredMessage[]>("/chat/starred");
}

// Removes every message in the conversation for everyone (server fans out a
// `chat_cleared` WS event to all participants).
export function clearChat(convId: number) {
  return api.delete(`/chat/conversations/${convId}/messages`);
}

export function forwardMessage(messageId: number, conversationIds: number[]) {
  return api.post(`/chat/messages/${messageId}/forward`, { conversationIds });
}

export function pinConversation(convId: number) {
  return api.post<{ pinned: boolean }>(`/chat/conversations/${convId}/pin`);
}

export function favouriteConversation(convId: number) {
  return api.post<{ favourite: boolean }>(
    `/chat/conversations/${convId}/favourite`,
  );
}

export function deleteConversation(convId: number) {
  return api.delete(`/chat/conversations/${convId}`);
}

export function getAllCallHistory() {
  return api.get<CallLogEntry[]>("/chat/calls");
}

export function getConversationCalls(convId: number) {
  return api.get<CallLogEntry[]>(`/chat/conversations/${convId}/calls`);
}

/**
 * The user's currently-active (answered) call, if any. Mirrors the web client's
 * getActiveCall (GET /chat/calls/active) and is used by the mobile rejoin path
 * (OngoingCallBanner) to detect a still-live call the user navigated away from
 * and let them tap back into it. Returns `null` when there is no active call.
 */
export type ActiveCall = {
  id: number;
  conversation_id: number;
  caller_id: number;
  call_type: "audio" | "video" | string;
  status: string;
  started_at?: string;
  caller_name?: string | null;
  caller_avatar?: string | null;
  is_group?: boolean;
  group_name?: string | null;
  other_user_id?: number | null;
  other_name?: string | null;
  other_avatar?: string | null;
};

export function getActiveCall() {
  return api.get<ActiveCall | null>("/chat/calls/active");
}

export function getIceConfig() {
  return api.get<IceConfig>("/chat/ice-config");
}

// ── ICE config cache ──────────────────────────────────────────────────────
// Warmed once at app start (see app/_layout.tsx) and read by the call screen so
// `waitForIceConfig()` resolves INSTANTLY instead of polling for up to 1200ms
// on every call. The cached value is reused while fresh (TURN creds carry an
// `expiresAt`); a stale/absent cache simply falls back to a live fetch.
let cachedIceConfig: IceConfig | null = null;
let cachedIceConfigAt = 0;
const ICE_CACHE_TTL_MS = 5 * 60_000;

/** Returns the in-memory ICE config if still fresh, else null. */
export function getCachedIceConfig(): IceConfig | null {
  if (!cachedIceConfig) return null;
  // Respect server-provided expiry when present (epoch seconds).
  const expiresAt = cachedIceConfig.expiresAt;
  if (typeof expiresAt === "number" && Date.now() / 1000 >= expiresAt) {
    cachedIceConfig = null;
    return null;
  }
  if (Date.now() - cachedIceConfigAt > ICE_CACHE_TTL_MS) {
    cachedIceConfig = null;
    return null;
  }
  return cachedIceConfig;
}

/**
 * Fetches the ICE config and populates the in-memory cache. Safe to call at app
 * start to pre-warm; never throws (returns null on failure).
 */
export async function warmIceConfig(): Promise<IceConfig | null> {
  try {
    const r = await getIceConfig();
    if (r.data?.iceServers?.length) {
      cachedIceConfig = r.data;
      cachedIceConfigAt = Date.now();
      return r.data;
    }
  } catch {
    /* best-effort pre-warm */
  }
  return null;
}

/**
 * HTTP fallback for declining an incoming call. Used when the realtime
 * WebSocket is slow to come up (e.g. from a headless/killed-state task) so the
 * decline ALWAYS reaches the server and the caller stops ringing. Mirrors the
 * WS `call_reject` transition server-side.
 */
export function rejectCallHttp(callId: number | string, conversationId: number | string) {
  return api.post(`/chat/calls/${callId}/reject`, { conversationId });
}

/**
 * HTTP fallback for accepting an incoming call (parity with rejectCallHttp).
 * Mirrors the WS `call_accept` transition server-side.
 */
export function acceptCallHttp(callId: number | string, conversationId: number | string) {
  return api.post(`/chat/calls/${callId}/accept`, { conversationId });
}

/**
 * HTTP fallback for ENDING a call. Used when the realtime WS `call_end` frame
 * could not be confirmed sent on hang-up (socket briefly down, app killed right
 * after). Without this the server's `call_logs` row sticks at `answered` and the
 * "Ongoing call — Return" banner keeps re-appearing. Mirrors the WS `call_end`
 * transition server-side; idempotent when the call is already terminal.
 */
export function endCallHttp(callId: number | string, conversationId: number | string) {
  return api.post(`/chat/calls/${callId}/end`, { conversationId });
}

/* ───────────────────────── Notes ───────────────────────── */

// Full NotePage shape — mirrors the web client's NotePage so notebook content
// round-trips losslessly between web and mobile via the same /notes blob.
export type NotePage = {
  id: string;
  title: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string | number | null;
  lastEditedBy?: string | number | null;
  pinned?: boolean;
  tags?: string[];
  folderId?: string | null;
  parentPageId?: string | null;
  archived?: boolean;
  sortOrder?: number;
  icon?: string;
  coverColor?: string;
  readOnly?: boolean;
  properties?: Record<string, unknown>;
  reactions?: Record<string, unknown>;
  [key: string]: unknown;
};

export type NoteFolder = {
  id: string;
  name: string;
  parentId?: string | null;
  sortOrder?: number;
  [key: string]: unknown;
};

export type NoteTodo = {
  id: string;
  text: string;
  done: boolean;
  priority?: "low" | "medium" | "high" | null;
  dueDate?: string | null;
  createdAt?: string;
  completedAt?: string | null;
  sortOrder?: number;
};

export type Notebook = {
  pages: NotePage[];
  folders?: NoteFolder[];
  todos?: NoteTodo[];
  activePageId?: string | null;
  sortBy?: string;
  [k: string]: unknown;
};

export function getNotes() {
  return api.get<{ data: Notebook | null; updatedAt?: string }>("/notes");
}

export function saveNotes(data: Notebook) {
  return api.put("/notes", { data });
}

/* ── Tier 6 integrations (daily journal / 1-on-1 prefill, convert-to-task) ── */

export type DailyPrefill = {
  tasks?: Array<{ id: number; title: string; status: string; priority: string }>;
  hoursWorked?: number | null;
  meetings?: Array<{ title?: string; scheduled_start?: string }>;
  events?: Array<{ title?: string; all_day?: boolean; start_time?: string }>;
  date?: string;
  [k: string]: unknown;
};

export function getDailyPrefill() {
  return api.get<DailyPrefill>("/notes/daily-prefill");
}

export type OneOnOnePrefill = {
  report?: { id: number; fullName?: string } | null;
  tasks?: Array<{ status?: string; title?: string }>;
  leaves?: Array<{ date?: string; leave_type?: string; duration?: string; status?: string }>;
  sprint?: { name?: string; taskBreakdown?: Array<{ status: string; count: number }> } | null;
  hoursThisWeek?: number | null;
  [k: string]: unknown;
};

export function getOneOnOnePrefill(userId: number | string) {
  return api.get<OneOnOnePrefill>(`/notes/oneonone-prefill/${userId}`);
}

export function convertNoteToTask(title: string, pageId: string) {
  return api.post<{ task: { id: number; title: string } }>("/notes/convert-to-task", {
    title,
    pageId,
  });
}

export type NoteDirectReport = {
  id: number;
  full_name: string;
  avatar?: string | null;
  username?: string;
};

export function getNoteDirectReports() {
  return api.get<{ reports: NoteDirectReport[] }>("/notes/direct-reports");
}

/* ── Public share links ── */

export function getNoteShare(pageId: string) {
  return api.get<{ token: string | null; url?: string; page_title?: string }>(
    `/notes/share/${pageId}`,
  );
}

export function createNoteShare(pageId: string) {
  return api.post<{ token: string; url: string }>(`/notes/share/${pageId}`);
}

export function revokeNoteShare(pageId: string) {
  return api.delete(`/notes/share/${pageId}`);
}

/* ───────────────────────── Avatar ───────────────────────── */

export function uploadAvatar(uri: string) {
  const name = uri.split("/").pop() || "avatar.jpg";
  const match = /\.(\w+)$/.exec(name);
  const ext = (match?.[1] || "jpg").toLowerCase();
  const type = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const form = new FormData();
  // React Native FormData file shape.
  form.append("avatar", { uri, name, type } as any);
  return api.post<{ avatar: string }>("/profile/avatar", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
}

/* ───────────────────────── Calendar ───────────────────────── */

export type CalendarEvent = {
  id: number;
  title: string;
  description?: string | null;
  start_time: string;
  end_time: string;
  all_day: boolean;
  color?: string | null;
  task_title?: string | null;
  meeting_code?: string | null;
  meeting_created_by?: number | null;
};

export function getCalendarEvents(from: string, to: string) {
  return api.get<CalendarEvent[]>("/calendar", { params: { from, to } });
}

export function createCalendarEvent(data: {
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  all_day?: boolean;
  color?: string;
  // Optional linkage to an online meeting (mirrors the web calendar). When
  // present, the server fans the event out to every meeting participant.
  meeting_id?: number | null;
  task_id?: number | string | null;
}) {
  return api.post<CalendarEvent>("/calendar", data);
}

export function deleteCalendarEvent(id: number) {
  return api.delete(`/calendar/${id}`);
}

export function updateCalendarEvent(
  id: number,
  data: {
    title?: string;
    description?: string;
    start_time?: string;
    end_time?: string;
    all_day?: boolean;
    color?: string;
  },
) {
  return api.put<CalendarEvent>(`/calendar/${id}`, data);
}

/* ───────────────────────── Meetings ───────────────────────── */

export type MeetingSettings = {
  muteOnJoin: boolean;
  allowScreenShare: boolean;
};

// Create an online meeting (mirrors the web `createMeeting`). Returns the new
// meeting row including its `id` (link it to a calendar event via `meeting_id`)
// and its shareable `meeting_code`.
export function createMeeting(data: {
  title: string;
  description?: string;
  required_participant_ids?: number[];
  optional_participant_ids?: number[];
  settings?: MeetingSettings;
  start_time: string;
  end_time: string;
}) {
  return api.post<{ id: number; meeting_code: string; [k: string]: unknown }>(
    "/meetings",
    data,
  );
}

export type MeetingParticipant = {
  user_id: number;
  full_name?: string | null;
  username?: string | null;
  avatar?: string | null;
  role?: "organizer" | "participant" | string;
  participant_type?: "required" | "optional" | string | null;
  status?: string | null;
};

export type MeetingDetail = {
  id: number;
  meeting_code: string;
  title: string;
  description?: string | null;
  created_by?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  participants?: MeetingParticipant[];
  [k: string]: unknown;
};

// Fetch a single meeting by its shareable code (mirrors the web `getMeeting`).
// The response includes a `participants` array with role/participant_type so the
// calendar can render Required/Optional badges and the organizer tag.
export function getMeeting(code: string) {
  return api.get<MeetingDetail>(`/meetings/${code}`);
}

export type MeetingConflict = {
  userId: number;
  name: string;
  events: { id: number; title: string; start_time: string; end_time: string }[];
};

// Check whether any invitees already have a calendar event overlapping the
// proposed slot (mirrors the web `checkMeetingConflicts`).
export function checkMeetingConflicts(data: {
  user_ids: number[];
  start_time: string;
  end_time: string;
}) {
  return api.post<{ conflicts: MeetingConflict[] }>(
    "/meetings/check-conflicts",
    data,
  );
}

/* ───────────── Leave apply / Task create ───────────── */

export function applyLeave(data: {
  leave_type: string;
  dates: string[];
  duration?: "full" | "half" | "quarter";
  reason?: string;
}) {
  return api.post("/leaves", data);
}

export function createTask(data: {
  title: string;
  description?: string;
  priority?: TaskPriority;
}) {
  return api.post<Task>("/tasks", data);
}

export function getTaskDetail(id: number) {
  return api.get<Task & { comments?: TaskComment[] }>(`/tasks/${id}/detail`);
}

export type TaskSummary = {
  total: number;
  done: number;
  pending: number;
  inProgress: number;
  inReview: number;
  activeTasks: { title: string; priority: TaskPriority; status: TaskStatus }[];
};

export function getTaskSummary() {
  return api.get<TaskSummary>("/tracker/task-summary");
}

/* ───────────── Profile update ───────────── */

export function updateProfile(data: { full_name?: string; username?: string }) {
  return api.put("/profile", data);
}

export function updateEmail(email: string) {
  return api.put<{ email: string }>("/profile/email", { email });
}

export function changePassword(data: {
  current_password: string;
  new_password: string;
}) {
  return api.put("/profile/password", data);
}

export function removeAvatar() {
  return api.delete<{ avatar: null }>("/profile/avatar");
}

/* ───────────── User status (v2 presence) ───────────── */

// Manual statuses the user can pick. `null` clears the choice (resolver falls
// back to 'available'). Mirrors client/src/status/constants.ts.
export type ManualStatus = "available" | "busy" | "dnd" | "brb";
export type PresencePreference = "auto" | "invisible";
export type EffectiveStatus =
  | "available"
  | "busy"
  | "dnd"
  | "brb"
  | "away"
  | "in_call"
  | "in_meeting"
  | "offline";

export type StatusPayload = {
  userId: number;
  effective: EffectiveStatus | string;
  presence: string;
  manualStatus: ManualStatus | null;
  presencePreference: PresencePreference | string;
  statusMessage: string | null;
  statusMessageExpiresAt: string | null;
  source: string;
};

export function getMyStatus() {
  return api.get<StatusPayload>("/me/status");
}

export function setMyStatus(body: {
  status: ManualStatus | null;
  message?: string | null;
  messageExpiresAt?: string | null;
}) {
  return api.put<StatusPayload>("/me/status", body);
}

export function setPresencePreference(preference: PresencePreference) {
  return api.put<StatusPayload>("/me/status/presence-preference", {
    preference,
  });
}

/* ───────────── Notification sound preferences ───────────── */

export type NotificationPrefs = {
  v?: number;
  ringtone?: string;
  outgoingTone?: string;
  messageTone?: string;
  mentionTone?: string;
  reactionTone?: string;
  ringtoneVolume?: number;
  outgoingVolume?: number;
  messageVolume?: number;
  mentionVolume?: number;
  reactionVolume?: number;
  muteAll?: boolean;
  playWhenFocused?: boolean;
  playOnSend?: boolean;
};

export function getNotificationPrefs() {
  return api.get<NotificationPrefs>("/profile/notification-prefs");
}

export function saveNotificationPrefs(prefs: NotificationPrefs) {
  return api.put<NotificationPrefs>("/profile/notification-prefs", prefs);
}

/* ───────────── Face enrollment ───────────── */

export type FaceStatus = { enrolled: boolean; enrolled_at: string | null };

export function getFaceStatus() {
  return api.get<FaceStatus>("/profile/face-status");
}

export function enrollFace(descriptor: number[]) {
  return api.post<{ message: string; enrolled: boolean; enrolled_at: string }>(
    "/profile/face-enroll",
    { descriptor },
  );
}

export function clearFaceEnrollment() {
  return api.delete<{ message: string; enrolled: boolean }>(
    "/profile/face-enroll",
  );
}

/* ───────────────────────── Announcements ───────────────────────── */

export type Announcement = {
  id: number;
  type: "info" | "warning" | "success" | "quote" | string;
  message: string;
};

export function getActiveAnnouncements() {
  return api.get<{ data?: Announcement[] } | Announcement[]>(
    "/notifications/announcements",
  );
}

/* ───────────────────────── Active Sprint ───────────────────────── */

export function getActiveSprint() {
  return api.get<{ sprint: Sprint | null }>("/sprints/active");
}

export function getSprintTasksFull(sprintId: number) {
  return api.get<{ tasks: (Task & { assigned_to?: number })[] }>(
    `/sprints/${sprintId}/tasks`,
  );
}

export type SprintStats = {
  sprint: { id: number; name: string; status: string };
  totals: {
    tasks: number;
    points: number;
    doneTasks: number;
    donePoints: number;
    remainingPoints: number;
    unestimatedTasks: number;
    blockedTasks: number;
    percentByPoints: number;
    percentByTasks: number;
  };
  byState?: unknown[];
  byType?: unknown[];
  byAssignee?: unknown[];
};

export function getSprintStats(sprintId: number) {
  return api.get<SprintStats>(`/sprints/${sprintId}/stats`);
}

export function startSprint(sprintId: number) {
  return api.post<{ sprint: Sprint }>(`/sprints/${sprintId}/start`);
}

export function completeSprint(
  sprintId: number,
  rolloverTo?: number | "backlog",
) {
  return api.post<{
    sprint: Sprint;
    velocity: number;
    doneTasks: number;
    totalTasks: number;
    rolledOver: number;
  }>(`/sprints/${sprintId}/complete`, rolloverTo ? { rolloverTo } : {});
}

/* ───────────────────────── Sprint Insights (Phase 3) ───────────────────────── */

// All sprints visible to the requester, grouped by status on the server. The
// response is `{ sprints: Sprint[] }` (mirrors the web `getSprints`).
export function getSprints() {
  return api.get<{ sprints: Sprint[] }>("/sprints");
}

export type SprintCycleTime = {
  cycle: { avg: number | null; median: number | null; p90: number | null; n: number };
  lead: { avg: number | null; median: number | null; p90: number | null; n: number };
  tasks: Array<{
    id: number;
    title: string;
    type_name?: string | null;
    type_color?: string | null;
    story_points?: number | string | null;
    cycle_days?: number | null;
    lead_days?: number | null;
    completed_at: string;
  }>;
};

export function getSprintCycleTime(sprintId: number) {
  return api.get<SprintCycleTime>(`/sprints/${sprintId}/cycle-time`);
}

export type SprintCumulativeFlow = {
  series: Array<{ date: string; [category: string]: number | string }>;
};

export function getSprintCumulativeFlow(sprintId: number) {
  return api.get<SprintCumulativeFlow>(`/sprints/${sprintId}/cumulative-flow`);
}

export type SprintRetrospective = {
  id?: number;
  went_well?: string | null;
  to_improve?: string | null;
  summary?: string | null;
  team_mood?: number | null;
  action_items?: Array<{
    id: number | string;
    text: string;
    done?: boolean;
    owner?: number | null;
    due_date?: string | null;
  }>;
};

export function getSprintRetrospective(sprintId: number) {
  return api.get<{ retrospective: SprintRetrospective | null }>(
    `/sprints/${sprintId}/retrospective`,
  );
}

export function updateSprintRetrospective(
  sprintId: number,
  data: {
    went_well?: string | null;
    to_improve?: string | null;
    summary?: string | null;
    team_mood?: number | null;
    action_items?: unknown[];
  },
) {
  return api.put<{ retrospective: SprintRetrospective }>(
    `/sprints/${sprintId}/retrospective`,
    data,
  );
}

/**
 * Move a backlog ticket into (or out of, when sprintId is null) a sprint.
 * Mirrors the web `assignTaskToSprint` — PATCH /tasks/:id/assign-sprint.
 */
export function assignTaskToSprint(
  taskId: number,
  sprintId: number | null,
) {
  return api.patch<Task>(`/tasks/${taskId}/assign-sprint`, {
    sprint_id: sprintId,
  });
}

/**
 * Update a task's assignee / due date when importing it into a sprint.
 * Mirrors the web `updateTask` PUT /tasks/:id with a partial body.
 */
export function updateTaskAssignment(
  taskId: number,
  data: { assigned_to?: number | null; due_date?: string | null },
) {
  return api.put<Task>(`/tasks/${taskId}`, data);
}

/* ───────────────────────── Service Desk ───────────────────────── */

export type ServiceDeskTicket = {
  id: number;
  tenant_id: number;
  submitted_by_user_id: number;
  submitted_by_name: string;
  submitted_by_email?: string | null;
  ticket_type: "bug" | "feature_request" | "access_issue" | "other" | string;
  title: string;
  description?: string | null;
  priority: "low" | "medium" | "high" | "critical" | string;
  status:
    | "open"
    | "acknowledged"
    | "in_progress"
    | "resolved"
    | "closed"
    | string;
  assigned_to?: string | null;
  admin_notes?: string | null;
  tenant_name?: string | null;
  created_at: string;
  resolved_at?: string | null;
};

export type ServiceDeskStats = {
  total: number;
  open: number;
  acknowledged: number;
  in_progress: number;
  resolved: number;
  closed: number;
};

export function getServiceDeskTickets(params?: Record<string, string>) {
  return api.get<{
    tickets: ServiceDeskTicket[];
    total: number;
    page: number;
    perPage: number;
  }>("/service-desk/tickets", { params });
}

export function getServiceDeskStats() {
  return api.get<ServiceDeskStats>("/service-desk/stats");
}

export function createServiceDeskTicket(data: {
  title: string;
  description?: string;
  ticket_type: string;
  priority?: string;
}) {
  return api.post<ServiceDeskTicket>("/service-desk/tickets", data);
}

export function deleteServiceDeskTicket(id: number) {
  return api.delete(`/service-desk/tickets/${id}`);
}

/* ───────────── Task assignees / labels / schedule / history ───────────── */

export type AssignableUser = {
  id: number;
  username?: string;
  full_name: string;
  avatar?: string | null;
};

export function getAssignableUsers() {
  return api.get<AssignableUser[]>("/tasks/assignable-users");
}

export type TaskLabel = {
  id: number;
  name: string;
  color?: string;
};

export function getTaskLabels() {
  return api.get<TaskLabel[]>("/tasks/labels");
}

export function scheduleTask(id: number, date: string) {
  return api.patch(`/tasks/${id}/schedule`, { date });
}

export function unscheduleTask(id: number) {
  return api.patch(`/tasks/${id}/unschedule`);
}

export type TaskHistoryEntry = {
  id: number;
  action: string;
  old_value?: string | null;
  new_value?: string | null;
  full_name?: string;
  created_at: string;
};

export function getTaskHistory(id: number) {
  return api.get<TaskHistoryEntry[]>(`/tasks/${id}/history`);
}

export function getTaskComments(id: number) {
  return api.get<TaskComment[]>(`/tasks/${id}/comments`);
}

/* ───────────────────────── Tracker / Attendance ───────────────────────── */

// Single source of truth for tracker status lives in ./tracker.ts. Re-export
// so callers can import either from here or there without divergence.
export {
  getTrackerStatus,
  clockIn,
  clockOut,
  breakStart,
  breakEnd,
} from "./tracker";
export type { TrackerStatus, WorkState } from "./tracker";

export type HistoryEntry = {
  date: string;
  clock_in?: string | null;
  clock_out?: string | null;
  work_mode?: string | null;
  floorMinutes?: number;
  breakMinutes?: number;
  breaks?: { start: string; end?: string | null }[];
};

export function getTrackerHistory(from: string, to: string) {
  return api.get<HistoryEntry[]>("/tracker/history", {
    params: { from, to },
  });
}

export type AnalyticsPoint = {
  date: string;
  floorMinutes: number;
  breakMinutes: number;
  workMode?: string;
};

export function getTrackerAnalytics(days = 7) {
  return api.get<AnalyticsPoint[]>("/tracker/analytics", {
    params: { days: String(days) },
  });
}

export function addManualEntry(data: {
  date: string;
  clock_in: string;
  clock_out?: string;
  breaks?: { start: string; end: string }[];
  timezoneOffset?: number;
  work_mode?: "office" | "remote" | "hybrid";
}) {
  return api.post("/tracker/manual-entry", data);
}

/** Atomic update of all entries for a date (delete + re-insert in one tx). */
export function updateManualEntry(
  date: string,
  data: {
    clock_in: string;
    clock_out?: string;
    breaks?: { start: string; end: string }[];
    timezoneOffset?: number;
    work_mode?: "office" | "remote" | "hybrid";
  },
) {
  return api.put(`/tracker/manual-entry/${date}`, data);
}

/** Raw tracker entries for a single day (used to detect existing entries). */
export type TrackerEntry = {
  id: number;
  entry_type: string;
  timestamp: string;
  is_manual?: boolean;
  work_mode?: string | null;
};

export function getEntries(date: string) {
  return api.get<TrackerEntry[]>(`/tracker/entries/${date}`);
}

/** Pending manual-entry approval requests raised by the current user.
 *  The server nests the entry details under `metadata` (date, clock_in,
 *  clock_out, work_mode) — mirrors GET /tracker/manual-entries. */
export type ManualEntryRequest = {
  request_id: number;
  approval_status: "pending" | "approved" | "rejected" | string;
  reject_reason?: string | null;
  created_at?: string;
  reviewed_at?: string | null;
  approver_name?: string | null;
  metadata?: {
    date?: string;
    clock_in?: string;
    clock_out?: string | null;
    work_mode?: string;
    [k: string]: unknown;
  } | null;
  [k: string]: unknown;
};

export function getManualEntryRequests() {
  return api.get<ManualEntryRequest[]>("/tracker/manual-entries");
}

/** Overtime requests raised by the current user. The date/hours live under
 *  `metadata` (mirrors GET /tracker/overtime-requests). */
export type OvertimeRequest = {
  id: number;
  reason?: string | null;
  status: "pending" | "approved" | "rejected" | string;
  reject_reason?: string | null;
  created_at?: string;
  approver_name?: string | null;
  metadata?: {
    date?: string;
    hours?: number;
    [k: string]: unknown;
  } | null;
};

export function getOvertimeRequests() {
  return api.get<OvertimeRequest[]>("/tracker/overtime-requests");
}

export function submitOvertimeRequest(data: {
  date: string;
  hours: number;
  reason: string;
}) {
  return api.post("/tracker/overtime-request", data);
}

/** Dashboard widgets (analytics extras shown on web). */
export function getTrackerWidgets() {
  return api.get<Record<string, unknown>>("/tracker/widgets");
}

/* ───────────────────────── Manager / My Team ───────────────────────── */

/**
 * Shape returned by GET /manager/team-attendance (a bare array). Field names
 * mirror the server exactly: `status` ∈ working | away | not_started | on_leave,
 * `state` ∈ on_floor | on_break | logged_out.
 */
export type TeamMember = {
  id: number;
  full_name: string;
  avatar?: string | null;
  role?: string;
  status: "working" | "away" | "not_started" | "on_leave";
  state?: "on_floor" | "on_break" | "logged_out";
  hours_today?: number;
  floorMinutes?: number;
  breakMinutes?: number;
  workMode?: string;
  clockInTime?: string | null;
  current_task?: string | null;
  leave_type?: string | null;
};

export function getTeamAttendance(date?: string) {
  // Server returns a bare array, not { members }.
  return api.get<TeamMember[]>("/manager/team-attendance", {
    params: date ? { date } : undefined,
  });
}

export type Approval = {
  id: number;
  type: "leave" | "leave_withdraw" | "manual_entry" | "overtime" | string;
  status: "pending" | "approved" | "rejected" | string;
  requester_id?: number;
  requester_name?: string;
  requester_avatar?: string | null;
  approver_name?: string;
  created_at?: string;
  reviewed_at?: string | null;
  reject_reason?: string | null;
  reference_id?: number | null;
  // Type-specific details live inside metadata (date, dates, leave_type,
  // start_date/end_date, reason, duration, clock_in/clock_out, etc.).
  metadata?: {
    date?: string;
    dates?: string[];
    start_date?: string;
    end_date?: string;
    leave_type?: string;
    reason?: string | null;
    duration?: string;
    clock_in?: string;
    clock_out?: string;
    [k: string]: unknown;
  } | null;
};

export function getApprovals(params?: Record<string, string>) {
  return api.get<Approval[]>("/manager/approvals", { params });
}

export function getMyRequests(params?: Record<string, string>) {
  return api.get<Approval[]>("/manager/my-requests", { params });
}

export function approveRequest(id: number, remarks?: string) {
  return api.post(`/manager/approvals/${id}/approve`, { remarks });
}

export function rejectRequest(id: number, reason?: string) {
  return api.post(`/manager/approvals/${id}/reject`, { reject_reason: reason });
}

export function bulkApproval(ids: number[], action: string, reason?: string) {
  return api.post("/manager/approvals/bulk", {
    ids,
    action,
    reject_reason: reason,
  });
}

/**
 * Per-member performance row returned inside the `members` array of
 * GET /manager/team-analytics. Field names mirror the web client exactly.
 */
export type TeamAnalyticsMember = {
  id: number;
  full_name: string;
  email?: string;
  avatar?: string | null;
  role?: string;
  department_name?: string | null;
  team_name?: string | null;
  hours?: number;
  avgFloorMinutes?: number;
  tasksDone?: number;
  tasksTotal?: number;
  targetMetPercent?: number;
  punctualityPercent?: number;
  todayStatus?: string;
  todayHoursMin?: number;
  trend?: { date: string; floorMinutes: number }[];
};

export type TeamAnalytics = {
  totalMembers?: number;
  avgHours?: number;
  totalTasksDone?: number;
  avgTargetMet?: number;
  avgPunctuality?: number;
  pendingApprovals?: number;
  targetMinutes?: number;
  expectedWeekdays?: number;
  members?: TeamAnalyticsMember[];
};

export function getTeamAnalytics(days?: number, from?: string, to?: string) {
  return api.get<TeamAnalytics>("/manager/team-analytics", {
    params: { days, from, to },
  });
}

/* ───────────── Team member detail (manager drill-down) ───────────── */

// Leave balance row as returned inside the member overview. Mirrors the
// employee's own /leaves/balance shape — the server now coerces NUMERIC
// columns to numbers and adds total_days / remaining convenience fields so
// the manager view shows identical numbers to the member's own login.
export type MemberLeaveBalance = {
  leave_type: string;
  policy_name?: string | null;
  color?: string | null;
  quota: number;
  carried_forward: number;
  used: number;
  total_days: number;
  remaining: number;
  year?: number | string;
};

export type MemberRecentLeave = {
  id: number;
  leave_type: string;
  date: string;
  duration?: string;
  status: string;
  reason?: string | null;
};

export type MemberOverview = {
  user: {
    id: number;
    full_name: string;
    email?: string | null;
    avatar?: string | null;
    role?: string;
    department_name?: string | null;
    team_name?: string | null;
  };
  todayHours: number;
  todayBreakMin: number;
  todayTasks: Array<{ id: number; title: string; status: string; priority: string }>;
  pendingRequests: number;
  monthLeaves: number;
  recentLeaves: MemberRecentLeave[];
  recentRequests: Approval[];
  weeklyTrend: Array<{
    date: string;
    dayLabel: string;
    floorMinutes: number;
    breakMinutes: number;
    workMode?: string | null;
  }>;
  stats30d: {
    daysWorked: number;
    totalFloorMinutes: number;
    avgFloorMinutes: number;
    avgBreakMinutes: number;
    targetMetDays: number;
    targetMetPercent: number;
    punctualityPercent: number;
  };
  monthTaskStats: {
    total: number;
    done: number;
    inProgress: number;
    completionRate: number;
  };
  leaveBalances: MemberLeaveBalance[];
};

export function getMemberOverview(userId: number | string) {
  return api.get<MemberOverview>(`/manager/member/${userId}/overview`);
}

/* ───────────────────────── Organization ───────────────────────── */

// Mirrors GET /org/current. The server returns the `organizations` row
// directly (NOT wrapped) with camelCase aggregate counts and the work-policy
// columns flattened at the top level — do NOT expect a nested `settings`
// object or snake_case `*_count` fields here.
export type OrgInfo = {
  id: number;
  name: string;
  slug?: string | null;
  custom_domain?: string | null;
  domain?: string | null;
  // Work-policy columns (top-level on the organizations table).
  work_hours_per_day?: number | null;
  work_days?: string | null;
  timezone?: string | null;
  fiscal_year_start?: string | null;
  // Attendance / presence policy.
  min_hours_present?: number | string | null;
  office_start_time?: string | null;
  office_address?: string | null;
  // Aggregate counts (hr_admin+ only — omitted for lower roles).
  memberCount?: number;
  deptCount?: number;
  teamCount?: number;
  // Attendance verification (face + geofence/wifi). When
  // `attendance_verification_enabled` is true, clock-in requires a face
  // descriptor and (for office/hybrid) a location or office Wi-Fi BSSID.
  attendance_verification_enabled?: boolean;
  office_latitude?: number | string | null;
  office_longitude?: number | string | null;
  office_radius_m?: number | null;
  office_wifi_verification_enabled?: boolean;
  office_wifi_bssids?: unknown[] | null;
};

export function getCurrentOrg() {
  return api.get<OrgInfo | null>("/org/current");
}

export type OrgMember = {
  id: number;
  full_name: string;
  username?: string;
  email?: string | null;
  avatar?: string | null;
  role: string;
  department_name?: string | null;
  team_name?: string | null;
};

// GET /org/members returns the standard backend envelope
// `{ data, total, page, perPage }` — the member rows are under `data`, not
// `members`.
export function getOrgMembers(params?: Record<string, string>) {
  return api.get<{ data: OrgMember[]; total: number; page: number; perPage: number }>(
    "/org/members",
    { params },
  );
}

export type OrgDepartment = {
  id: number;
  name: string;
  description?: string | null;
  head_id?: number | null;
  head_name?: string | null;
  member_count?: number;
};

export function getOrgDepartments(params?: Record<string, string>) {
  return api.get<OrgDepartment[]>("/org/departments", { params });
}

export type OrgTeam = {
  id: number;
  name: string;
  department_id?: number | null;
  department_name?: string | null;
  lead_id?: number | null;
  lead_name?: string | null;
  member_count?: number;
  sprint_duration_weeks?: number | null;
  sprint_start_date?: string | null;
};

export function getOrgTeams(params?: Record<string, string>) {
  return api.get<OrgTeam[]>("/org/teams", { params });
}

/* ───────────────────────── Org Chart (self-service) ───────────────────────── */

export type OrgChartMember = {
  id: number | string;
  full_name: string;
  avatar?: string | null;
  role: string;
  email?: string | null;
  department_id?: number | string | null;
  department_name?: string | null;
  team_id?: number | string | null;
  team_name?: string | null;
  manager_id?: number | string | null;
  manager_name?: string | null;
};

export type OrgChartDept = {
  id: number | string;
  name: string;
  head_name?: string | null;
};

export type OrgChartTeam = {
  id: number | string;
  name: string;
  department_id?: number | string | null;
  lead_name?: string | null;
};

export type OrgChart = {
  members: OrgChartMember[];
  departments: OrgChartDept[];
  teams: OrgChartTeam[];
};

export function getOrgChart() {
  return api.get<OrgChart>("/org/chart");
}

/* ───────────────────────── Salary Slips (self-service) ───────────────────────── */

// Mirrors GET /compensation/my-slips (employee self-service). Returns the
// employee's own published salary slips with disbursement status joined in.
export type MySalarySlip = {
  id: number;
  slip_month: string;
  gross_earnings: number | string;
  total_deductions: number | string;
  net_pay: number | string;
  disbursement_status?: string | null;
  utr?: string | null;
  paid_at?: string | null;
};

export function getMySalarySlips() {
  return api.get<MySalarySlip[]>("/compensation/my-slips");
}

/** Path (relative to API_BASE_URL) for the employee's own salary-slip PDF. */
export function mySalarySlipPdfPath(id: number | string) {
  return `/compensation/my-slips/${id}/pdf`;
}

// Mirrors GET /compensation/my-bank-details. The account number is masked by
// the server; saving requires the full number.
export type MyBankDetails = {
  account_holder_name?: string | null;
  account_number?: string | null;
  ifsc_code?: string | null;
  bank_name?: string | null;
  account_type?: string | null;
  is_verified?: boolean;
};

export function getMyBankDetails() {
  return api.get<MyBankDetails | null>("/compensation/my-bank-details");
}

export function saveMyBankDetails(data: {
  account_holder_name: string;
  account_number: string;
  ifsc_code: string;
  bank_name?: string;
  account_type?: string;
}) {
  return api.post<{ message: string }>("/compensation/my-bank-details", data);
}
