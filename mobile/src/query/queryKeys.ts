/**
 * Centralised, typed React Query key factory.
 *
 * PROBLEM THIS SOLVES: keys were written as raw inline arrays at ~128 call
 * sites (51 `useQuery` + 77 `invalidateQueries`). Because invalidation matches
 * by structural PREFIX, a key that drifts from the one the query registered
 * under fails SILENTLY — no error, the screen just keeps showing stale data.
 *
 * Every entry below mirrors a key that ALREADY EXISTS in the codebase, so
 * migrating a call site is a pure find-and-replace with no behaviour change.
 *
 * RULES
 *  1. Build every key here. Never inline a raw array at a call site.
 *  2. Keys are hierarchical (broad → narrow) so a parent invalidation cascades:
 *     `qk.admin.projects()` clears every `projectList(...)` filter variant.
 *  3. `as const` everywhere — a typo becomes a COMPILE error rather than a
 *     silent cache miss.
 *
 * Usage:
 *     useQuery({ queryKey: qk.admin.projectList(showArchived), ... })
 *     queryClient.invalidateQueries({ queryKey: qk.admin.projects() })
 */

/** Scalar values that can safely participate in a cache key. */
type KeyParam = string | number | boolean | null | undefined;

export const qk = {
  /* ── Tasks & sprints ─────────────────────────────────────────────────── */
  tasks: {
    all: () => ["tasks"] as const,
    /** Parent of every sprint-scoped task cache. */
    sprint: () => ["tasks", "sprint"] as const,
    sprintTasks: (sprintId: KeyParam) => ["tasks", "sprint", sprintId] as const,
    sprints: () => ["tasks", "sprints"] as const,
  },

  sprints: {
    all: () => ["sprints"] as const,
    list: () => ["sprints", "list"] as const,
  },

  /* ── Leaves ──────────────────────────────────────────────────────────── */
  leaves: {
    all: () => ["leaves"] as const,
    balance: (year: KeyParam) => ["leaves", "balance", year] as const,
    history: (month: KeyParam) => ["leaves", "history", month] as const,
    policies: () => ["leaves", "policies"] as const,
    allBalances: () => ["leaves", "allBalances"] as const,
  },

  /* ── Attendance ──────────────────────────────────────────────────────── */
  attendance: {
    all: () => ["attendance"] as const,
    analytics: (range: KeyParam, from: KeyParam, to: KeyParam) =>
      ["attendance", "analytics", range, from, to] as const,
  },

  /* ── Notifications ───────────────────────────────────────────────────── */
  notifications: {
    all: () => ["notifications"] as const,
  },

  /* ── Profile ─────────────────────────────────────────────────────────── */
  profile: {
    all: () => ["profile"] as const,
    face: () => ["profile", "face"] as const,
    tracker: () => ["profile", "tracker"] as const,
    notificationPrefs: () => ["profile", "notificationPrefs"] as const,
  },

  /* ── Member / team ───────────────────────────────────────────────────── */
  member: {
    all: () => ["member"] as const,
    detail: (userId: KeyParam) => ["member", userId] as const,
  },

  team: {
    all: () => ["team"] as const,
    attendance: () => ["team", "attendance"] as const,
    myRequests: () => ["team", "myRequests"] as const,
  },

  /* ── Organization ────────────────────────────────────────────────────── */
  org: {
    all: () => ["org"] as const,
    current: () => ["org", "current"] as const,
    chart: () => ["org", "chart"] as const,
    taskLabels: () => ["org", "taskLabels"] as const,
    salarySlips: () => ["org", "salarySlips"] as const,
    departments: () => ["org", "departments"] as const,
    departmentList: (orgId: KeyParam) =>
      ["org", "departments", orgId ?? null] as const,
    teams: () => ["org", "teams"] as const,
    teamList: (orgId: KeyParam) => ["org", "teams", orgId ?? null] as const,
  },

  /* ── Admin ───────────────────────────────────────────────────────────── */
  admin: {
    all: () => ["admin"] as const,
    home: () => ["admin", "home"] as const,
    agileConfig: () => ["admin", "agileConfig"] as const,
    badges: () => ["admin", "badges"] as const,
    compensation: () => ["admin", "compensation"] as const,
    integrations: () => ["admin", "integrations"] as const,
    orgChart: () => ["admin", "orgChart"] as const,
    orgSettings: () => ["admin", "orgSettings"] as const,
    paymentSettings: () => ["admin", "paymentSettings"] as const,
    platformAccess: () => ["admin", "platformAccess"] as const,
    payroll: () => ["admin", "payroll"] as const,
    salarySlipPeriods: () => ["admin", "salarySlipPeriods"] as const,
    salarySlips: (periodId: KeyParam) =>
      ["admin", "salarySlips", periodId] as const,

    audit: (range: KeyParam, page: KeyParam) =>
      ["admin", "audit", range, page] as const,

    // NOTE the parent/child pairs below. The list variants carry a filter
    // segment; the bare parent is what mutations invalidate so EVERY filter
    // variant is refreshed at once. Keeping both here is what prevents the
    // two from drifting apart.
    departments: () => ["admin", "departments"] as const,
    departmentList: (orgId: KeyParam) =>
      ["admin", "departments", orgId ?? null] as const,

    projects: () => ["admin", "projects"] as const,
    projectList: (showArchived: KeyParam) =>
      ["admin", "projects", showArchived ?? null] as const,

    roleRequests: () => ["admin", "roleRequests"] as const,
    roleRequestList: (tab: KeyParam) =>
      ["admin", "roleRequests", tab ?? null] as const,

    teams: () => ["admin", "teams"] as const,
    teamList: (orgId: KeyParam) => ["admin", "teams", orgId ?? null] as const,

    users: () => ["admin", "users"] as const,
    userList: (search: KeyParam, filter: KeyParam) =>
      ["admin", "users", search ?? null, filter ?? null] as const,

    addPeople: () => ["admin", "addPeople"] as const,
    addPeopleOrgs: () => ["admin", "addPeople", "orgs"] as const,
    addPeopleRefData: (orgId: KeyParam) =>
      ["admin", "addPeople", "refData", orgId ?? null] as const,
  },
} as const;

/** Convenience alias for call sites that prefer the longer name. */
export const queryKeys = qk;
