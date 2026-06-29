/**
 * Group-chat permission helper — the hybrid model.
 *
 * Two orthogonal axes govern every group action:
 *
 *   1. Local conversation role (conversation_participants.role):
 *        owner  → all actions
 *        admin  → manage members / metadata / policy, start huddle, pin
 *        member → send (if post_policy allows), leave, react, reply
 *
 *   2. Org RBAC governance override (req.roleLevel from middleware/rbac.ts):
 *        a user whose org permission level is >= GOVERNANCE_LEVEL (hr_admin)
 *        may perform destructive / moderation actions on ANY group in their
 *        org even if they are not a member or only a 'member'. This is an
 *        escape hatch for compliance, never the primary path.
 *
 * The local role is the primary gate; org RBAC only *adds* capability for
 * moderation-class actions. A manager does NOT automatically own an
 * employee's group chat.
 *
 * Group post/add behaviour is further shaped by per-conversation policy
 * columns (conversations.post_policy / add_policy: 'all' | 'admins').
 */

export type GroupRole = "owner" | "admin" | "member";
export type GroupPolicy = "all" | "admins";

export type GroupAction =
  | "send" // post a message
  | "rename" // change group name
  | "set_metadata" // avatar / description
  | "set_policy" // post_policy / add_policy
  | "add_member"
  | "remove_member"
  | "set_role" // promote/demote admin
  | "transfer_owner"
  | "leave"
  | "start_huddle"
  | "pin"
  | "delete_group" // delete the whole conversation
  | "clear_messages"; // wipe all messages

export interface GroupContext {
  /** The caller's local role in this conversation, or null if not a member. */
  role: GroupRole | null;
  /** Per-conversation posting policy. */
  postPolicy: GroupPolicy;
  /** Per-conversation member-add policy. */
  addPolicy: GroupPolicy;
  /** The caller's org RBAC permission level (req.roleLevel). */
  orgRoleLevel: number;
}

/**
 * Org permission level at/above which a user gains the governance override.
 * 4 = hr_admin (see middleware/rbac.ts ROLE_LEVEL). Destructive / moderation
 * actions are allowed for hr_admin, super_admin (5), platform_admin (6).
 */
const GOVERNANCE_LEVEL = 4;

const isAdminish = (role: GroupRole | null): boolean =>
  role === "owner" || role === "admin";

/** Actions an org-governance user (>= GOVERNANCE_LEVEL) may always perform. */
const GOVERNANCE_ACTIONS: ReadonlySet<GroupAction> = new Set<GroupAction>([
  "rename",
  "set_metadata",
  "set_policy",
  "add_member",
  "remove_member",
  "set_role",
  "transfer_owner",
  "pin",
  "delete_group",
  "clear_messages",
  "send",
]);

/**
 * Core decision function. Returns true if the caller may perform `action`.
 */
function canDo(action: GroupAction, ctx: GroupContext): boolean {
  const { role, postPolicy, addPolicy, orgRoleLevel } = ctx;

  // 1. Org governance override (moderation / compliance escape hatch).
  if (orgRoleLevel >= GOVERNANCE_LEVEL && GOVERNANCE_ACTIONS.has(action)) {
    return true;
  }

  // 2. Local conversation role.
  switch (action) {
    case "send":
      if (!role) return false;
      return postPolicy === "all" ? true : isAdminish(role);

    case "leave":
      // Any member may leave. (Owner-leave requires transfer first — the
      // route enforces that separately so the helper stays pure.)
      return role !== null;

    case "start_huddle":
      // Members may start huddles (Slack default). Configurable later.
      return role !== null;

    case "pin":
      return isAdminish(role);

    case "rename":
    case "set_metadata":
    case "add_member":
    case "remove_member":
      // Admin-class management actions. add_member additionally honours
      // add_policy: when 'all', any member may add.
      if (action === "add_member" && addPolicy === "all") {
        return role !== null;
      }
      return isAdminish(role);

    case "set_policy":
    case "delete_group":
    case "clear_messages":
      // Owner-only by local role (governance already handled above).
      return role === "owner";

    case "set_role":
    case "transfer_owner":
      // Only the owner can change roles or hand over ownership.
      return role === "owner";

    default:
      return false;
  }
}

/**
 * Convenience: load the caller's group context for a conversation in one
 * query and return it, or null when the conversation isn't a group.
 *
 * `db.query` is the tenant-bound query function. `orgRoleLevel` comes from
 * req.roleLevel (resolved by loadUserContext / rbac middleware).
 */
async function loadGroupContext(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  conversationId: number,
  userId: number | undefined,
  orgRoleLevel: number,
): Promise<(GroupContext & { isGroup: boolean; createdBy: number | null }) | null> {
  const convRow = (
    await db.query(
      `SELECT is_group, created_by,
              COALESCE(post_policy, 'all')    AS post_policy,
              COALESCE(add_policy, 'admins')  AS add_policy
         FROM conversations WHERE id = $1`,
      [conversationId],
    )
  ).rows[0];
  if (!convRow) return null;

  const partRow = (
    await db.query(
      `SELECT role FROM conversation_participants
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    )
  ).rows[0];

  return {
    isGroup: !!convRow.is_group,
    createdBy: convRow.created_by ?? null,
    role: (partRow?.role as GroupRole) ?? null,
    postPolicy: (convRow.post_policy as GroupPolicy) ?? "all",
    addPolicy: (convRow.add_policy as GroupPolicy) ?? "admins",
    orgRoleLevel: orgRoleLevel ?? 1,
  };
}

module.exports = { canDo, loadGroupContext, GOVERNANCE_LEVEL };
module.exports.canDo = canDo;
module.exports.loadGroupContext = loadGroupContext;
module.exports.GOVERNANCE_LEVEL = GOVERNANCE_LEVEL;