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
  data: { title?: string; description?: string; priority?: TaskPriority },
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
};

export function addTaskComment(id: number, content: string) {
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
  story_points?: number | null;
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
  team_name?: string;
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

export type AgileConfig = {
  workflowStates: WorkflowState[];
  workItemTypes?: WorkItemType[];
  features?: { wipLimits?: boolean; storyPoints?: boolean; [k: string]: unknown };
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
  half_day_allowed?: boolean;
  quarter_day_allowed?: boolean;
};

export function getLeavePolicies() {
  return api.get<LeavePolicy[]>("/leave-policy/policies");
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

export function searchChatUsers(q: string) {
  return api.get<
    Array<{ id: number; username: string; full_name: string; avatar?: string | null }>
  >("/chat/search", { params: { q } });
}

export function startConversation(userId: number) {
  return api.post<{ id: number }>("/chat/conversations", { userId });
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
  return api.post<{ id: number }>("/chat/conversations/group", {
    name,
    userIds,
  });
}

export function uploadChatFile(convId: number, uri: string, fileName?: string) {
  const name = fileName || uri.split("/").pop() || "file";
  const match = /\.(\w+)$/.exec(name);
  const ext = (match?.[1] || "").toLowerCase();
  // Map common extensions to the MIME types the server's chat upload
  // fileFilter allows. Audio (voice notes) MUST be included — otherwise an
  // .m4a recording would fall back to application/octet-stream, which the
  // server rejects and the voice message silently fails to send.
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
    mp4: "audio/mp4",
    mp3: "audio/mpeg",
    aac: "audio/mp4",
    ogg: "audio/ogg",
    wav: "audio/wav",
    webm: "audio/webm",
  };
  const mime = MIME_BY_EXT[ext] || "application/octet-stream";
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

export function getIceConfig() {
  return api.get<IceConfig>("/chat/ice-config");
}

/* ───────────────────────── Notes ───────────────────────── */

export type NotePage = { id: string; title: string; content: string };
export type Notebook = { pages: NotePage[]; [k: string]: unknown };

export function getNotes() {
  return api.get<{ data: Notebook | null; updatedAt?: string }>("/notes");
}

export function saveNotes(data: Notebook) {
  return api.put("/notes", { data });
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

/** Pending manual-entry approval requests raised by the current user. */
export type ManualEntryRequest = {
  request_id: number;
  date?: string;
  approval_status: "pending" | "approved" | "rejected" | string;
  reject_reason?: string | null;
  created_at?: string;
  clock_in?: string;
  clock_out?: string;
  [k: string]: unknown;
};

export function getManualEntryRequests() {
  return api.get<ManualEntryRequest[]>("/tracker/manual-entries");
}

/** Overtime requests raised by the current user. */
export type OvertimeRequest = {
  id: number;
  date: string;
  hours: number;
  reason?: string | null;
  status: "pending" | "approved" | "rejected" | string;
  reject_reason?: string | null;
  created_at?: string;
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

export function getMyRequests() {
  return api.get<Approval[]>("/manager/my-requests");
}

export function approveRequest(id: number, remarks?: string) {
  return api.post(`/manager/approvals/${id}/approve`, { remarks });
}

export function rejectRequest(id: number, reason?: string) {
  return api.post(`/manager/approvals/${id}/reject`, { reject_reason: reason });
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

export function getOrgDepartments() {
  return api.get<
    { id: number; name: string; description?: string; member_count?: number }[]
  >("/org/departments");
}

export function getOrgTeams() {
  return api.get<
    { id: number; name: string; department_id?: number; member_count?: number }[]
  >("/org/teams");
}
