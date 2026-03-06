# WorkPulse — Architecture & Component Flow

## Folder Structure

```
client/src/
├── api.js                         # All API calls (~80+ functions)
├── AuthContext.jsx                 # Auth state (user, login, logout, updateUser)
├── ThemeContext.jsx                # Dark/light theme
├── WorkStateContext.jsx            # Work clock state
├── App.jsx                        # Router with lazy-loaded pages
├── hooks/
│   ├── useAutoDismiss.js          # Auto-clearing state (errors/messages)
│   └── useLiveTimer.js            # Live clock
├── components/
│   ├── Navbar.jsx                 # Top navigation bar
│   ├── Toast.jsx                  # Global toast notifications
│   ├── ConfirmDialog.jsx          # Confirmation modal
│   ├── SprintSelector.jsx         # Sprint picker widget
│   ├── TasksSummary.jsx           # Tasks summary widget
│   ├── WeeklyChart.jsx            # Weekly hours chart
│   ├── WidgetsGrid.jsx            # Dashboard widget grid
│   ├── TimelineCard.jsx           # Activity timeline card
│   ├── CommentSection.jsx         # Task comments
│   ├── EditProfileModal.jsx       # Profile editor
│   ├── ImageResizer.jsx           # Avatar uploader
│   ├── PasswordInput.jsx          # Password field with toggle
│   ├── ErrorBoundary.jsx          # React error boundary
│   ├── AxiosInterceptor.jsx       # Auth token injector
│   ├── DailyNotes/                # Rich-text daily notes module
│   │   ├── index.jsx              # Entry point
│   │   ├── useNotesStore.js       # Notes state management
│   │   ├── notesUtils.js          # Helpers
│   │   ├── quillConfig.js         # Quill editor config
│   │   └── components/
│   │       ├── FolderManager.jsx  # Note folder management
│   │       ├── InlineEditor.jsx   # Inline rich-text editor
│   │       └── ModalEditor.jsx    # Full-screen modal editor
│   └── organization/              # Shared org components (used by Admin & Organization pages)
│       ├── OrgSettings.jsx        # Organization settings form
│       ├── Departments.jsx        # Departments CRUD
│       ├── Teams.jsx              # Teams CRUD + sprint config
│       ├── OrgChartView.jsx       # Visual org chart
│       ├── OrgChart.module.css    # OrgChart-specific styles (cards, chips, badges)
│       └── TeamsConfig.module.css # Sprint config form styles
├── pages/
│   ├── Admin.jsx                  # Re-export → admin/index
│   ├── Admin.module.css           # Core shared styles (layout, tabs, table, badges, buttons) — 481 lines
│   ├── ManagerDashboard.jsx       # Re-export → manager/index
│   ├── LeavePolicy.jsx            # Re-export → leave-policy/index
│   ├── Organization.jsx           # Organization page (uses shared org components)
│   ├── Dashboard.jsx              # Employee dashboard
│   ├── Analytics.jsx              # Personal analytics
│   ├── Tasks.jsx                  # Task planner
│   ├── Leaves.jsx                 # Leave requests
│   ├── ManualEntry.jsx            # Manual time entry
│   ├── Login.jsx                  # Login page
│   ├── Register.jsx               # Registration page
│   ├── ForgotPassword.jsx         # Forgot password
│   ├── ResetPassword.jsx          # Reset password
│   ├── SetEmail.jsx               # Set email (OAuth users)
│   ├── ChangePassword.jsx         # Change password
│   ├── admin/                     # Admin panel (split from 1403-line Admin.jsx)
│   │   ├── index.jsx              # AdminPanel shell + stats
│   │   ├── constants.js           # ROLES, ROLE_LABELS
│   │   ├── UserManagement.jsx     # Users table with filters + actions
│   │   ├── AssignmentModal.jsx    # Assign user to org/dept/team
│   │   ├── ResetPasswordModal.jsx # Admin password reset
│   │   ├── CreateUser.jsx         # Create new user form
│   │   ├── AuditLogs.jsx          # Paginated audit log viewer
│   │   ├── TaskLabelsTab.jsx      # Task labels CRUD
│   │   ├── OrgModal.jsx           # Create/edit organization modal
│   │   ├── OrganizationsManagement.jsx  # All orgs (super_admin only)
│   │   ├── MyOrganization.jsx     # Current org with sub-tabs
│   │   ├── OrganizationsTab.jsx   # Org tab selector
│   │   ├── AdminForms.module.css  # Modal, formGroup, formActions, btnCancel, inlineInput etc.
│   │   ├── AdminUtils.module.css  # Text utilities, layout containers, section headings, inline inputs
│   │   ├── TaskLabels.module.css  # Color picker + label form/badge styles
│   │   └── AuditLogs.module.css   # Audit log table cell styles
│   ├── manager/                   # Manager dashboard (split from 964-line ManagerDashboard.jsx)
│   │   ├── index.jsx              # ManagerDashboard shell
│   │   ├── constants.js           # ROLE_LABELS, STATUS_COLORS, LEAVE_ICONS, formatMin
│   │   ├── TeamAttendance.jsx     # Team attendance tab
│   │   ├── MemberCard.jsx         # Team member card
│   │   ├── ApprovalsTab.jsx       # Approval management
│   │   ├── TeamAnalytics.jsx      # Team analytics with sorting/filtering
│   │   ├── TodayStatusBadge.jsx   # Today status badge (pure UI)
│   │   ├── PercentBar.jsx         # Progress bar (pure UI)
│   │   ├── MiniTrend.jsx          # Mini bar chart (pure UI)
│   │   ├── MemberExpandedCard.jsx # Expanded member details row
│   │   ├── MyRequests.jsx         # Manager's own requests
│   │   ├── EmployeeDashboard.jsx  # Employee drill-down view
│   │   ├── MemberOverview.jsx     # Employee overview tab
│   │   ├── MemberLeavesTab.jsx    # Employee leave history
│   │   ├── MemberRequestsTab.jsx  # Employee request history
│   │   ├── MemberHoursTab.jsx     # Employee hours log
│   │   ├── ApprovalBadge.jsx      # Approval status badge (pure UI)
│   │   ├── PriorityBadge.jsx      # Task priority badge (pure UI)
│   │   ├── StatusBadge.jsx        # Task status badge (pure UI)
│   │   └── RequestDetails.jsx     # Request metadata renderer
│   └── leave-policy/              # Leave policy management (split from 401-line LeavePolicy.jsx)
│       ├── index.jsx              # LeavePolicy shell
│       ├── PoliciesTab.jsx        # Leave policies CRUD
│       ├── PolicyForm.jsx         # Create/edit policy modal
│       ├── MyBalances.jsx         # My leave balances view
│       ├── HolidaysTab.jsx        # Holiday calendar management
│       ├── HolidayCard.jsx        # Single holiday card (pure UI)
│       └── AllBalances.jsx        # All employees' balances (HR view)
```

---

## Route Map

```
App.jsx (lazy loaded)
├── /login                   → Login.jsx
├── /register                → Register.jsx
├── /forgot-password         → ForgotPassword.jsx
├── /reset-password          → ResetPassword.jsx
├── /set-email               → SetEmail.jsx
├── /change-password         → ChangePassword.jsx
├── / (dashboard)            → Dashboard.jsx
├── /analytics               → Analytics.jsx
├── /tasks                   → Tasks.jsx
├── /leaves                  → Leaves.jsx
├── /manual-entry            → ManualEntry.jsx
├── /organization            → Organization.jsx
├── /leave-policy            → LeavePolicy.jsx  (→ leave-policy/index.jsx)
├── /admin                   → Admin.jsx         (→ admin/index.jsx)
└── /manager                 → ManagerDashboard.jsx (→ manager/index.jsx)
```

---

## Component Hierarchy

### Admin Panel

```
Admin.jsx (re-export)
└── admin/index.jsx (AdminPanel)
    ├── Stats grid (getAdminStats)
    ├── Tab: Users
    │   └── UserManagement.jsx
    │       ├── AssignmentModal.jsx
    │       └── ResetPasswordModal.jsx
    ├── Tab: Create User
    │   └── CreateUser.jsx
    ├── Tab: Organizations
    │   └── OrganizationsTab.jsx
    │       ├── OrganizationsManagement.jsx (super_admin only)
    │       │   └── OrgModal.jsx
    │       └── MyOrganization.jsx (if has org_id)
    │           ├── OrgSettings.jsx        ← shared from components/organization/
    │           ├── Departments.jsx        ← shared from components/organization/
    │           ├── Teams.jsx              ← shared from components/organization/
    │           └── OrgChartView.jsx       ← shared from components/organization/
    ├── Tab: Task Labels
    │   └── TaskLabelsTab.jsx
    └── Tab: Audit Logs
        └── AuditLogs.jsx
```

### Manager Dashboard

```
ManagerDashboard.jsx (re-export)
└── manager/index.jsx (ManagerDashboard)
    ├── If selectedMember → EmployeeDashboard.jsx
    │   ├── Member profile header
    │   ├── Tab: Overview → MemberOverview.jsx
    │   │   ├── ApprovalBadge.jsx
    │   │   ├── PriorityBadge.jsx
    │   │   ├── StatusBadge.jsx
    │   │   └── RequestDetails.jsx
    │   ├── Tab: Leaves → MemberLeavesTab.jsx
    │   │   └── ApprovalBadge.jsx
    │   ├── Tab: Requests → MemberRequestsTab.jsx
    │   │   ├── ApprovalBadge.jsx
    │   │   └── RequestDetails.jsx
    │   └── Tab: Hours → MemberHoursTab.jsx
    ├── Tab: Team Attendance → TeamAttendance.jsx
    │   └── MemberCard.jsx (clickable → sets selectedMember)
    ├── Tab: Approvals → ApprovalsTab.jsx
    │   ├── ApprovalBadge.jsx
    │   └── RequestDetails.jsx
    ├── Tab: Analytics → TeamAnalytics.jsx
    │   ├── TodayStatusBadge.jsx
    │   ├── PercentBar.jsx
    │   ├── MiniTrend.jsx
    │   └── MemberExpandedCard.jsx
    └── Tab: My Requests → MyRequests.jsx
        ├── ApprovalBadge.jsx
        └── RequestDetails.jsx
```

### Leave Policy

```
LeavePolicy.jsx (re-export)
└── leave-policy/index.jsx (LeavePolicy)
    ├── Tab: Policies (HR only) → PoliciesTab.jsx
    │   └── PolicyForm.jsx (create/edit modal)
    ├── Tab: My Balances → MyBalances.jsx
    ├── Tab: Holidays → HolidaysTab.jsx
    │   └── HolidayCard.jsx
    └── Tab: All Balances (HR only) → AllBalances.jsx
```

### Organization Page

```
Organization.jsx
├── If no org + super_admin → CreateOrgView (inline)
├── If no org + regular user → "not assigned" message
└── If has org →
    ├── Stats (memberCount, deptCount, teamCount, work hours)
    ├── Tab: Settings → OrgSettings.jsx     ← shared
    ├── Tab: Departments → Departments.jsx  ← shared
    ├── Tab: Teams → Teams.jsx              ← shared
    └── Tab: Org Chart → OrgChartView.jsx   ← shared
```

---

## Data Flow

```
AuthContext
  ├── user (id, role, org_id, full_name, avatar, email)
  ├── isAuthenticated
  ├── login(credentials)
  ├── logout()
  └── updateUser(partial)

API Layer (api.js)
  ├── Auth: login, register, logout, refreshToken, forgotPassword, resetPassword
  ├── Profile: getProfile, updateProfile, uploadAvatar
  ├── Tracker: clockIn, clockOut, startBreak, endBreak, getStatus, getTodayLog
  ├── Admin: getAdminUsers, createAdminUser, updateUserRole, toggleUserActive, deleteAdminUser
  │          getAdminOrganizations, createAdminOrganization, updateAdminOrganization
  │          getAdminTaskLabels, createAdminTaskLabel, updateAdminTaskLabel
  │          getAuditLogs, getAdminStats
  ├── Organization: getCurrentOrg, createOrg, updateOrgSettings
  │                 getOrgDepartments, createDepartment, updateDepartment, deleteDepartment
  │                 getOrgTeams, createTeam, updateTeam, deleteTeam
  │                 getOrgMembers, getOrgChart
  │                 getTeamSprintConfig, updateTeamSprintConfig
  ├── Manager: getTeamAttendance, getTeamAnalytics
  │            getApprovals, approveRequest, rejectRequest, bulkApproval
  │            getMemberOverview, getMemberLeaves, getMemberRequests, getMemberHours
  │            getMyRequests
  ├── Tasks: getTasks, createTask, updateTask, deleteTask, getSprintTasks
  ├── Leaves: getLeaves, createLeave, cancelLeave, withdrawLeave
  ├── LeavePolicy: getLeavePolicies, saveLeavePolicyAPI, deleteLeavePolicyAPI
  │               getLeaveBalances, getUserLeaveBalances, updateLeaveBalance
  │               getHolidays, addHoliday, deleteHoliday
  └── Notes: getNotes, createNote, updateNote, deleteNote (and folder ops)

Role Hierarchy
  employee(1) → team_lead(2) → manager(3) → hr_admin(4) → super_admin(5)
  
  Page access:
  - /admin       → hr_admin, super_admin
  - /manager     → team_lead, manager, hr_admin, super_admin
  - /leave-policy → all (with HR-only tabs)
  - /organization → all (with HR/admin-only actions)
  - /tasks, /leaves, /manual-entry → all
```

---

## Shared Component Reuse

| Component | Used by |
|-----------|---------|
| `OrgSettings` | `admin/MyOrganization`, `Organization` |
| `Departments` | `admin/MyOrganization`, `Organization` |
| `Teams` | `admin/MyOrganization`, `Organization` |
| `OrgChartView` | `admin/MyOrganization`, `Organization` |
| `ApprovalBadge` | `ApprovalsTab`, `MemberOverview`, `MemberLeavesTab`, `MemberRequestsTab`, `MyRequests` |
| `RequestDetails` | `ApprovalsTab`, `MemberOverview`, `MemberRequestsTab`, `MyRequests` |
| `PriorityBadge` | `MemberOverview` |
| `StatusBadge` | `MemberOverview` |
| `TodayStatusBadge` | `TeamAnalytics` |
| `PercentBar` | `TeamAnalytics` |
| `MiniTrend` | `TeamAnalytics` |
| `MemberExpandedCard` | `TeamAnalytics` |

---

## Code Size Before vs After Refactoring

| File | Before | After |
|------|--------|-------|
| `Admin.jsx` | 1403 lines | 1 line (re-export) |
| `ManagerDashboard.jsx` | 964 lines | 1 line (re-export) |
| `LeavePolicy.jsx` | 401 lines | 1 line (re-export) |
| `Organization.jsx` | 503 lines | ~93 lines |
| `Admin.module.css` | 819 lines | 481 lines |
| New component files | — | ~49 files, avg ~60 lines each |
| New CSS modules | — | 6 files (AdminForms, AdminUtils, TaskLabels, AuditLogs, OrgChart, TeamsConfig) |
| Duplicate org code eliminated | ~600 lines | 0 (shared components) |

---

## CSS Module Structure

All shared styling flows from `Admin.module.css`. Component-specific styles are extracted into co-located modules:

```
Admin.module.css (481 lines)        ← layout, tabs, toolbar, table, badges, buttons, avatars
  │
  ├── admin/AdminForms.module.css   ← modalOverlay, modal, formGroup, formSection,
  │                                    createUserForm, sectionTitle, formActions,
  │                                    btnCancel, hint, inlineInput, inlineSelect
  │
  ├── admin/AdminUtils.module.css   ← text utilities (text-xs, text-muted-sm…),
  │                                    section headings, layout containers (form-container,
  │                                    tab-content, overflow-auto…), inline-form,
  │                                    actions-row, form/edit-inline-input, delete-warning
  │
  ├── admin/TaskLabels.module.css   ← color-picker-row, color-swatch (circle), color-input
  │                                    (circle, cross-browser), label-form, label-badge
  │
  ├── admin/AuditLogs.module.css    ← audit-time, audit-details, badge-accent
  │
  ├── organization/OrgChart.module.css   ← card-panel, dept-header, team-card,
  │                                         member-chip, mini-avatar-sm, badge-sm,
  │                                         unassigned-section, bold-heading, flex-wrap
  │
  └── organization/TeamsConfig.module.css ← sprint-edit-row, sprint-config-form,
                                             sprint-field, field-label, field-hint
```

**Import alias convention:**

| Alias | Module |
|-------|--------|
| `s` | `Admin.module.css` (shared core) |
| `sf` | `AdminForms.module.css` |
| `su` | `AdminUtils.module.css` |
| `tl` | `TaskLabels.module.css` |
| `al` | `AuditLogs.module.css` |
| `oc` | `OrgChart.module.css` |
| `tc` | `TeamsConfig.module.css` |
| `m` | `ManagerDashboard.module.css` |
