# WorkPulse — Architecture & Developer Guide

> **WorkPulse** is a full-stack employee productivity platform with time tracking, task management,
> real-time chat, WebRTC video/voice calls, meeting rooms, leave management, calendar, notes, and
> enterprise admin features. Built with React + Vite (client) and Express + PostgreSQL (server),
> with optional Redis caching, BullMQ job scheduling, and WebSocket-based real-time communication.

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Repository Layout](#repository-layout)
3. [Client Architecture](#client-architecture)
   - [Entry Point & Provider Tree](#entry-point--provider-tree)
   - [Route Map](#route-map)
   - [Folder Structure — Full Tree](#client-folder-structure)
   - [Contexts & Global State](#contexts--global-state)
   - [Hooks](#hooks)
   - [Constants & Utils](#constants--utils)
   - [Component Hierarchy](#component-hierarchy)
4. [Server Architecture](#server-architecture)
   - [Entry Point & Middleware Stack](#entry-point--middleware-stack)
   - [Folder Structure](#server-folder-structure)
   - [Database Schema](#database-schema)
   - [Authentication & Authorization](#authentication--authorization)
   - [Rate Limiting](#rate-limiting)
   - [Background Jobs](#background-jobs)
   - [Redis Caching Layer](#redis-caching-layer)
5. [Real-Time Communication](#real-time-communication)
   - [WebSocket Architecture](#websocket-architecture)
   - [Chat Events](#chat-websocket-events)
   - [Call Events (WebRTC)](#call-websocket-events-webrtc)
   - [Meeting Events (WebRTC Mesh)](#meeting-websocket-events-webrtc-mesh)
   - [Presence](#presence)
6. [API Layer (Client)](#api-layer-client)
7. [Data Flow Diagrams](#data-flow-diagrams)
8. [CSS Architecture](#css-architecture)
9. [Shared Component Reuse](#shared-component-reuse)
10. [Testing](#testing)
11. [Build & Deployment](#build--deployment)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, Vite 7, React Router v6, CSS Modules, Recharts, Quill (rich text), highlight.js |
| **Backend** | Node.js, Express, PostgreSQL (pg), JWT (HttpOnly cookies), Helmet, express-rate-limit |
| **Real-time** | Native `ws` WebSocket server (WS library), WebRTC (peer-to-peer calls & mesh meetings) |
| **Caching** | Redis (ioredis) — optional, graceful degradation to in-memory |
| **Jobs** | BullMQ (Redis-backed) — falls back to `setInterval` without Redis |
| **Logging** | Pino (structured JSON via `utils/logger.js`) |
| **File uploads** | Multer → `server/uploads/` (authenticated static serving) |
| **Email** | Nodemailer (`utils/mailer.js`) — password resets, invites |
| **PWA** | Service worker (`public/sw.js`), Web Manifest |
| **Testing** | Vitest + React Testing Library (client), Jest + Supertest (server) |
| **Deployment** | Docker / Railway, Caddy reverse proxy (see `Caddyfile`, `Dockerfile`) |

---

## Repository Layout

```
WorkPulse/
├── client/                        # React SPA (Vite)
│   ├── index.html                 # HTML entry point
│   ├── package.json               # Client dependencies and scripts
│   ├── vite.config.js             # Vite config (proxy, build, test)
│   ├── public/
│   │   ├── manifest.json          # PWA manifest
│   │   └── sw.js                  # Service worker
│   └── src/                       # Source code (see full tree below)
├── server/                        # Express API server (TypeScript, multi-tenant)
│   ├── index.ts                   # Entry point (Express + HTTP + WS setup)
│   ├── migrate.ts                 # Pre-start migration runner
│   ├── db.ts                      # Master pool + master/tenant schema
│   ├── redis.ts                   # Redis client + tenant-scoped cache helpers
│   ├── jobs.ts                    # BullMQ / setInterval background jobs
│   ├── package.json               # Server dependencies and scripts
│   ├── middleware/                 # auth, tenant, rbac, impersonationAudit, maintenanceMode, agileEditor
│   ├── routes/                    # 38 route modules
│   ├── services/                  # push notifications, chat media, sprint scheduler, status v2, …
│   ├── utils/                     # tenantManager, migrationRunner, ws, collaboration, …
│   ├── types/                     # domain types + Express request augmentation
│   ├── uploads/                   # User-uploaded files (avatars, chat files)
│   └── __tests__/                 # 47 test suites
├── desktop/                       # Electron desktop app (tray, PiP call window, biometrics, updater)
├── mobile/                        # Expo / React Native mobile app
├── docs/                          # Feature design docs + ADRs (calls, chat, biometric login, …)
├── infra/coturn/                  # TURN server deployment for WebRTC
├── specs/                         # Feature specs (push notifications, call startup, POS plugin, …)
├── ARCHITECTURE.md                # This file
├── API_DOCUMENTATION.md           # Full REST + WebSocket API reference
├── docker-compose.yml             # Dev: Postgres + Redis containers
├── Dockerfile                     # Production multi-stage build
├── Caddyfile                      # Reverse proxy config
├── entrypoint.sh                  # Docker entrypoint
├── start-local.sh                 # Local build & run (Linux/macOS)
└── start-local.ps1                # Local build & run (Windows)
```

---

## Client Architecture

### Entry Point & Provider Tree

```
main.jsx
└── <React.StrictMode>
    └── <App />
        └── <BrowserRouter>
            └── <AuthProvider>                  ← JWT session, user profile, token refresh
                └── <ThemeProvider>              ← dark/light theme toggle
                    └── <WorkStateProvider>      ← clock-in/out/break state
                        └── <ChatProvider>       ← global unread count
                            └── <CallProvider>   ← incoming call detection (non-chat pages)
                                └── <MeetingProvider>  ← active meeting session (survives navigation)
                                    └── <ToastProvider> ← global toast notifications
                                        ├── <AxiosInterceptor /> ← 401 handling, auto-logout
                                        ├── <GlobalIncomingCall /> ← call overlay on non-chat pages
                                        ├── <MeetingPiP />  ← picture-in-picture when navigating away
                                        └── <AppRoutes />   ← protected + public routes
```

### Route Map

```
App.jsx (lazy-loaded pages wrapped in Suspense → PageSkeleton fallback)
│
├── PUBLIC ROUTES (redirect to / if authenticated)
│   ├── /login                   → Login.jsx
│   ├── /forgot-password         → ForgotPassword.jsx
│   └── /reset-password/:token   → ResetPassword.jsx
│
├── AUTHENTICATED ROUTES (redirect to /login if not authenticated)
│   ├── /change-password         → ChangePassword.jsx  (forced if must_change_password)
│   ├── /set-email               → SetEmail.jsx
│   ├── / (dashboard)            → Dashboard.jsx        (eagerly loaded)
│   ├── /analytics               → analytics/index.jsx  (lazy)
│   ├── /tasks                   → Tasks.jsx            (lazy)
│   ├── /leaves                  → Leaves.jsx           (lazy)
│   ├── /manual-entry            → ManualEntry.jsx       (lazy)
│   ├── /calendar                → CalendarPage.jsx      (lazy)
│   ├── /notes                   → NotesPage.jsx         (lazy)
│   ├── /chat                    → Chat.jsx              (lazy)
│   ├── /meeting/:code           → MeetingJoin.jsx       (lazy)
│   ├── /meeting/:code/room      → MeetingRoom.jsx       (lazy, hides Navbar)
│   ├── /organization            → Organization.jsx      (lazy)
│   └── /leave-policy            → LeavePolicy.jsx       (lazy)
│
├── ROLE-GATED ROUTES
│   ├── /admin                   → Admin.jsx  (minRole: hr_admin)
│   └── /manager                 → ManagerDashboard.jsx  (minRole: team_lead, or has_reports)
│
└── /* catch-all                 → null for keep-alive paths (rendered by KeepAlive),
                                   Navigate to / for genuinely unknown URLs,
                                   Navigate to /login when unauthenticated
```

> **Note:** there is no `/register` route — self-serve registration was removed.
> User enrollment is admin-only (Admin → Add People, or platform console for tenants).

### Client Folder Structure

```
client/src/
├── main.jsx                       # React 18 entry, service worker registration
├── App.jsx                        # Router, providers, lazy loading
├── api.js                         # Axios instance + ~120 API functions
├── global.css                     # CSS variables, resets, theme, animations
├── hljs-setup.js                  # highlight.js language registration
├── test-setup.js                  # Vitest setup (jsdom)
│
├── ── CONTEXTS ──
├── AuthContext.jsx                 # JWT auth state, profile, token refresh
├── ThemeContext.jsx                # Dark/light theme persistence
├── WorkStateContext.jsx            # Work clock state (logged_out/working/break)
├── ChatContext.jsx                 # Global unread message count
├── CallContext.jsx                 # Incoming call detection + global overlay
├── MeetingContext.jsx              # Active meeting session (WebSocket + stream refs)
│
├── hooks/
│   ├── useAsyncAction.js          # Loading/error wrapper for async ops
│   ├── useAutoDismiss.js          # Auto-clearing state (errors/messages)
│   ├── useChatNotification.js     # Browser push notifications for chat
│   ├── useClickOutside.js         # Detect clicks outside a ref
│   ├── useDashboardData.js        # All dashboard state + side-effects
│   ├── useEventReminder.js        # Calendar event reminders (10 min before)
│   ├── useGlobalSearch.js         # Debounced search hook for GlobalSearch component
│   ├── useLiveTimer.js            # Live elapsed-time counter
│   └── useWebSocket.js            # WebSocket connection with auto-reconnect
│
├── constants/
│   ├── index.js                   # ROLE_LEVEL, timing constants (refresh, poll intervals)
│   ├── icons.js                   # Central Lucide React icon registry
│   └── leaves.js                  # LEAVE_TYPES, STATUS_CONFIG, getLeaveType()
│
├── utils/
│   ├── date.js                    # Date formatting helpers
│   └── time.js                    # Time/duration formatting helpers
│
├── components/
│   ├── common/                    # Shared UI primitives (barrel: index.js)
│   │   ├── AxiosInterceptor.jsx   # 401 auto-logout, token refresh
│   │   ├── ConfirmDialog.jsx      # Modal confirmation dialog
│   │   ├── ErrorBoundary.jsx      # React error boundary with reset
│   │   ├── ExportButton.jsx       # CSV/XLSX export trigger
│   │   ├── ImageResizer.jsx       # Avatar upload + client-side resize
│   │   ├── MentionInput.jsx       # @mention autocomplete input
│   │   ├── PageSkeleton.jsx       # Lazy-load placeholder skeleton
│   │   ├── PasswordInput.jsx      # Password field with visibility toggle
│   │   ├── SprintSelector.jsx     # Sprint picker dropdown
│   │   └── Toast.jsx              # Toast notification system (ToastProvider + useToast)
│   │
│   ├── navbar/                    # Top navigation (barrel: index.js)
│   │   ├── Navbar.jsx             # Main nav bar
│   │   ├── NavLinks.jsx           # Desktop navigation links
│   │   ├── ProfileMenu.jsx        # User avatar dropdown + profile modal
│   │   └── MobileTabBar.jsx       # Bottom tab bar for mobile
│   │
│   ├── search/                    # Global search (barrel: index.js)
│   │   └── GlobalSearch.jsx       # Spotlight-style search overlay
│   │
│   ├── dashboard/                 # Dashboard widgets (barrel: index.js)
│   │   ├── TasksSummary.jsx       # Today's task status breakdown
│   │   ├── TimelineCard.jsx       # Activity timeline (clock events)
│   │   ├── TodayEventsCard.jsx    # Upcoming calendar events widget
│   │   ├── WeeklyChart.jsx        # Weekly work hours bar chart
│   │   └── WidgetsGrid.jsx        # Responsive widget grid layout
│   │
│   ├── notifications/             # Notification components (barrel: index.js)
│   │   ├── NotificationBell.jsx   # Notification dropdown bell
│   │   ├── EventReminderToast.jsx # Calendar event reminder toast
│   │   └── GlobalIncomingCall.jsx # Incoming call overlay (non-chat pages)
│   │
│   ├── profile/                   # Profile components (barrel: index.js)
│   │   ├── EditProfileModal.jsx   # Profile editor modal
│   │   └── CommentSection.jsx     # Task comment thread
│   │
│   ├── meeting/                   # Meeting components (barrel: index.js)
│   │   └── MeetingPiP.jsx         # Floating PiP when user leaves meeting room
│   │
│   ├── calendar/                  # Calendar reusable components
│   │   ├── Calendar.jsx           # Calendar grid view
│   │   └── EventFormModal.jsx     # Event create/edit modal
│   │
│   ├── chat/                      # Chat UI components (barrel: index.js)
│   │   ├── CallOverlay.jsx        # Voice/video call full-screen overlay
│   │   ├── ChatAvatar.jsx         # User avatar with presence dot
│   │   ├── CodeBlock.jsx          # Syntax-highlighted code blocks
│   │   ├── ContextMenu.jsx        # Right-click context menu
│   │   ├── DeliveryStatus.jsx     # Sent/delivered/read ticks
│   │   ├── EmojiGifPicker.jsx     # Emoji & GIF picker panel
│   │   ├── FilePreview.jsx        # Image/file preview in messages
│   │   ├── FormatToolbar.jsx      # Message format toolbar (bold, code, etc.)
│   │   ├── ForwardModal.jsx       # Forward message to conversations
│   │   ├── GroupModal.jsx         # Create/edit group chat modal
│   │   ├── MeetingCard.jsx        # Meeting card embedded in chat
│   │   ├── MentionInput.jsx       # @mention input (chat variant)
│   │   ├── MessageBubble.jsx      # Single message container
│   │   ├── MessageContent.jsx     # Message content renderer (text/code/system)
│   │   ├── MessageSearch.jsx      # In-conversation message search
│   │   ├── MessageToolbar.jsx     # Hover toolbar (reply, react, pin, etc.)
│   │   ├── PinnedMessages.jsx     # Pinned messages panel
│   │   ├── PollCreator.jsx        # Create poll form
│   │   ├── PollDisplay.jsx        # Poll results visualization
│   │   ├── ReactionBar.jsx        # Emoji reactions row under messages
│   │   ├── ReactionPicker.jsx     # Reaction emoji selector
│   │   ├── ReplyPreview.jsx       # Reply-to preview banner
│   │   ├── SharedFilesPanel.jsx   # Shared files in conversation
│   │   ├── StarredMessages.jsx    # Starred messages panel
│   │   ├── SystemMessage.jsx      # System messages (joined, left, etc.)
│   │   ├── VoiceRecorder.jsx      # Voice message recorder
│   │   └── call/                  # Modularized call overlay
│   │       ├── index.jsx          # CallOverlay orchestrator
│   │       ├── useWebRTC.js       # WebRTC peer connection + signaling
│   │       ├── useCallControls.js # Mute, video, screen share, hold, PiP
│   │       ├── CallIcons.jsx      # 14 SVG icon components
│   │       ├── CallWidgets.jsx    # QualityBadge, DeviceSelector
│   │       └── AddParticipantPopup.jsx # Add user to active call
│   │
│   ├── DailyNotes/                # Rich-text notebook module
│   │   ├── index.jsx              # Entry point + layout
│   │   ├── useNotesStore.js       # Notes CRUD state management
│   │   ├── useNotesPersistence.js # Auto-save + server sync
│   │   ├── useNotesFilters.js     # Tag/folder filtering logic
│   │   ├── notesUtils.js          # Formatting helpers
│   │   ├── quillConfig.js         # Quill editor config + toolbar
│   │   └── components/
│   │       ├── FolderManager.jsx  # Folder tree management
│   │       ├── InlineEditor.jsx   # Inline Quill editor
│   │       ├── ModalEditor.jsx    # Full-screen modal editor
│   │       ├── ModalSidebar.jsx   # Modal sidebar navigation
│   │       ├── NotesHeader.jsx    # Notes toolbar header
│   │       ├── NotesModal.jsx     # Notes modal wrapper
│   │       ├── PageContextMenu.jsx # Right-click page menu
│   │       ├── PageItem.jsx       # Single page list item
│   │       ├── PageSwitcher.jsx   # Page/tab navigation
│   │       ├── QuillEditor.jsx    # Quill wrapper component
│   │       ├── TagDots.jsx        # Tag color dots
│   │       ├── TagEditor.jsx      # Tag CRUD editor
│   │       └── VersionHistory.jsx # Page version history viewer
│   │
│   └── organization/              # Shared org components (used by Admin & Organization page)
│       ├── OrgSettings.jsx        # Organization settings form
│       ├── Departments.jsx        # Departments CRUD
│       ├── Teams.jsx              # Teams CRUD + sprint config
│       └── OrgChartView.jsx       # Visual org chart
│
├── pages/
│   ├── Login.jsx                  # Login form
│   ├── ForgotPassword.jsx         # Forgot password flow
│   ├── ResetPassword.jsx          # Reset password (via email token)
│   ├── SetEmail.jsx               # Set email for OAuth users
│   ├── ChangePassword.jsx         # Forced/voluntary password change
│   │
│   ├── Dashboard.jsx              # Employee dashboard (eagerly loaded)
│   ├── dashboard/
│   │   ├── TimerCard.jsx          # Clock-in/out timer widget
│   │   └── DashboardSkeleton.jsx  # Loading skeleton
│   │
│   ├── Analytics.jsx              # Re-export → analytics/index
│   ├── analytics/
│   │   ├── index.jsx              # Analytics page shell
│   │   ├── SummaryStats.jsx       # Work/break hours summary cards
│   │   ├── WorkBreakChart.jsx     # Stacked work/break area chart
│   │   ├── TrendChart.jsx         # Daily hours trend line chart
│   │   ├── DistributionCharts.jsx # Pie charts (work mode, leave type)
│   │   ├── HistoryTable.jsx       # Day-by-day log table
│   │   └── chartConfig.js         # Recharts theme + tooltip config
│   │
│   ├── Tasks.jsx                  # Task planner page
│   ├── tasks/
│   │   ├── TaskContext.jsx        # Tasks page local state context
│   │   ├── TasksHeader.jsx        # Toolbar (filters, sprint selector, search)
│   │   ├── KanbanBoard.jsx        # Drag-and-drop kanban columns
│   │   ├── TaskCard.jsx           # Individual task card
│   │   ├── TaskDetailModal.jsx    # Task detail/edit modal
│   │   ├── InlineCommentPanel.jsx # Slide-in comment panel
│   │   ├── BacklogTab.jsx         # Backlog items list
│   │   ├── SprintImportPanel.jsx  # Import tasks between sprints
│   │   ├── LabelSelector.jsx      # Multi-select label picker
│   │   ├── constants.js           # Status/priority display config
│   │   ├── utils.jsx              # Task helpers
│   │   └── hooks/
│   │       ├── useBacklog.js      # Backlog CRUD
│   │       ├── useComments.js     # Task comments
│   │       ├── useConfirmDialog.js # Confirmation hook
│   │       ├── useDragDrop.js     # Kanban drag-and-drop logic
│   │       ├── useFilters.js      # Filter state management
│   │       ├── useGlobalSearch.js # Task search
│   │       └── useTaskDetail.js   # Task detail modal logic
│   │
│   ├── Chat.jsx                   # Chat page (main chat UI)
│   ├── chat/
│   │   ├── ChatSidebar.jsx        # Conversation list sidebar
│   │   ├── ConversationItem.jsx   # Single conversation list item
│   │   ├── ChatHeader.jsx         # Active chat header (call buttons, search)
│   │   ├── ChatMessages.jsx       # Message list with infinite scroll
│   │   ├── ChatInputBar.jsx       # Message composer (text, file, voice, poll)
│   │   ├── CallHistory.jsx        # Call log viewer for conversations
│   │   ├── CallsTab.jsx           # All calls history tab
│   │   ├── chatUtils.js           # Message formatting helpers
│   │   ├── useChatState.js        # Chat page state management
│   │   ├── useChatActions.js      # Message send/edit/delete actions
│   │   ├── useConversationActions.js # Conversation CRUD + navigation
│   │   ├── useMessageActions.js   # Pin, star, forward, react actions
│   │   ├── useCallState.js        # Active call state
│   │   └── useCallActions.js      # Call initiate/accept/reject actions
│   │
│   ├── Leaves.jsx                 # Leave management page
│   ├── leaves/
│   │   ├── LeaveRequestForm.jsx   # New leave request form
│   │   ├── LeaveHistory.jsx       # Leave history table
│   │   └── LeaveBalanceCards.jsx  # Leave balance summary cards
│   │
│   ├── ManualEntry.jsx            # Manual time entry page
│   ├── manualEntry/
│   │   ├── OvertimeRequestForm.jsx # Overtime request form
│   │   ├── PendingRequestsList.jsx # Pending requests display
│   │   └── manualEntryUtils.js    # Manual entry helpers
│   │
│   ├── CalendarPage.jsx           # Calendar page (events + meetings)
│   ├── NotesPage.jsx              # Notes page (DailyNotes wrapper)
│   ├── Organization.jsx           # Organization page (settings, depts, teams, chart)
│   │
│   ├── MeetingJoin.jsx            # Meeting join/lobby page
│   ├── MeetingRoom.jsx            # Full meeting room page
│   ├── meeting/
│   │   ├── MeetingBottomBar.jsx   # Meeting controls bar
│   │   ├── MeetingChat.jsx        # In-meeting chat panel
│   │   ├── MeetingParticipants.jsx # Participants panel
│   │   ├── ParticipantTile.jsx    # Individual participant video tile
│   │   ├── PresenterView.jsx      # Screen share / presenter layout
│   │   └── useMeetingState.js     # Meeting room state management
│   │
│   ├── Admin.jsx                  # Re-export → admin/index
│   ├── admin/
│   │   ├── index.jsx              # Admin panel shell + stats
│   │   ├── constants.js           # ROLES, ROLE_LABELS
│   │   ├── UserManagement.jsx     # Users table with search, filter, pagination
│   │   ├── AssignmentModal.jsx    # Assign user to org/dept/team
│   │   ├── ResetPasswordModal.jsx # Admin password reset
│   │   ├── CreateUser.jsx         # Create new user form
│   │   ├── ImportUsers.jsx        # Bulk user import (CSV/JSON)
│   │   ├── RoleRequests.jsx       # Role change request queue
│   │   ├── PayPeriods.jsx         # Pay period locking management
│   │   ├── AuditLogs.jsx          # Paginated audit log viewer
│   │   ├── TaskLabelsTab.jsx      # Task labels CRUD
│   │   ├── OrgModal.jsx           # Create/edit organization modal
│   │   ├── OrganizationsManagement.jsx  # All orgs (super_admin only)
│   │   ├── MyOrganization.jsx     # Current org with sub-tabs
│   │   └── OrganizationsTab.jsx   # Org tab selector
│   │
│   ├── ManagerDashboard.jsx       # Re-export → manager/index
│   ├── manager/
│   │   ├── index.jsx              # Manager dashboard shell
│   │   ├── constants.js           # ROLE_LABELS, STATUS_COLORS, formatMin
│   │   ├── TeamAttendance.jsx     # Team attendance grid
│   │   ├── MemberCard.jsx         # Team member card
│   │   ├── ApprovalsTab.jsx       # Approval queue (leaves, overtime, manual)
│   │   ├── TeamAnalytics.jsx      # Team analytics with sorting/filtering
│   │   ├── EmployeeDashboard.jsx  # Employee drill-down view
│   │   ├── MemberOverview.jsx     # Employee overview tab
│   │   ├── MemberLeavesTab.jsx    # Employee leave history
│   │   ├── MemberRequestsTab.jsx  # Employee request history
│   │   ├── MemberHoursTab.jsx     # Employee hours log
│   │   ├── MyRequests.jsx         # Manager's own requests
│   │   ├── MemberExpandedCard.jsx # Expanded member details row
│   │   ├── ApprovalBadge.jsx      # Approval status badge
│   │   ├── PriorityBadge.jsx      # Task priority badge
│   │   ├── StatusBadge.jsx        # Task status badge
│   │   ├── TodayStatusBadge.jsx   # Today status badge
│   │   ├── PercentBar.jsx         # Progress bar
│   │   ├── MiniTrend.jsx          # Mini bar chart
│   │   └── RequestDetails.jsx     # Request metadata renderer
│   │
│   ├── LeavePolicy.jsx            # Re-export → leave-policy/index
│   └── leave-policy/
│       ├── index.jsx              # Leave policy shell
│       ├── PoliciesTab.jsx        # Leave policies CRUD (HR only)
│       ├── PolicyForm.jsx         # Create/edit policy modal
│       ├── MyBalances.jsx         # My leave balances view
│       ├── HolidaysTab.jsx        # Holiday calendar management
│       ├── HolidayCard.jsx        # Single holiday card
│       └── AllBalances.jsx        # All employees' balances (HR view)
│
└── __tests__/                     # Integration tests (Vitest + React Testing Library)
    ├── AuthContext.test.jsx
    ├── CalendarPage.test.jsx
    ├── ConfirmDialog.test.jsx
    ├── GlobalSearch.test.jsx
    ├── Leaves.test.jsx
    ├── Login.test.jsx
    ├── ManualEntry.test.jsx
    ├── Navbar.test.jsx
    ├── NotesPage.test.jsx
    ├── TimerCard.test.jsx
    └── Toast.test.jsx
```

### Contexts & Global State

| Context | File | State | Purpose |
|---------|------|-------|---------|
| **AuthContext** | `AuthContext.jsx` | `user`, `isAuthenticated`, `isInitializing` | JWT session management. Verifies profile on load via `getProfile()`. Caches only display-safe fields (no role/permissions) in localStorage. Auto-refreshes token every 30min. |
| **ThemeContext** | `ThemeContext.jsx` | `theme` (dark/light) | Persists user theme preference to server (`PUT /tracker/theme`). |
| **WorkStateContext** | `WorkStateContext.jsx` | `workState`, `workMode` | Bootstraps clock state from server on load. Values: `logged_out`, `working`, `on_break`. Work modes: `office`, `remote`, `hybrid`. |
| **ChatContext** | `ChatContext.jsx` | `unreadCount` | Maintains global unread message count for Navbar badge. |
| **CallContext** | `CallContext.jsx` | `globalIncomingCall`, `pendingAcceptedCall` | Listens to WebSocket for `call_incoming` events when NOT on the Chat page. Shows `GlobalIncomingCall` overlay. On accept, stores call data and navigates to Chat. |
| **MeetingContext** | `MeetingContext.jsx` | `session`, `wsRef`, `localStreamRef` | Keeps an active meeting alive across route changes. Manages the meeting WebSocket, local media stream, and peer connections. Enables PiP overlay when user navigates away from `/meeting/:code/room`. |

### Hooks

| Hook | Purpose |
|------|---------|
| `useAsyncAction` | Wraps async operations with loading/error state |
| `useAutoDismiss(ms)` | State that auto-clears after `ms` (default 5s) — used for flash messages |
| `useChatNotification` | Browser push notification for incoming chat messages |
| `useClickOutside(ref, cb)` | Triggers callback when clicking outside a referenced element |
| `useDashboardData` | All Dashboard state: timer, widgets, weekly chart, tasks summary, calendar events, quotes rotation, confetti |
| `useEventReminder(events)` | Fires reminder toasts 10 minutes before calendar events |
| `useGlobalSearch` | Debounced search with API calls for GlobalSearch component |
| `useLiveTimer(startTime)` | Ticking elapsed-time display (HH:MM:SS) |
| `useWebSocket(onMessage)` | Auto-reconnecting WebSocket client. Auth via HttpOnly cookie. Reconnects after 3s on disconnect (except auth failure 4001). |

### Constants & Utils

**`constants/index.js`:**
```js
ROLE_LEVEL = { employee: 1, team_lead: 2, manager: 3, hr_admin: 4, super_admin: 5, platform_admin: 6 }
REFRESH_TOKEN_INTERVAL = 30 min
QUOTE_ROTATION_INTERVAL = 20 sec
STATUS_POLL_INTERVAL = 2 min
NOTIFICATION_POLL_INTERVAL = 30 sec
```

**`constants/leaves.js`:** `LEAVE_TYPES` array (sick, holiday, planned, personal, other), `STATUS_CONFIG` map.

**`constants/icons.js`:** Central Lucide React icon registry (single import point for all icons).

**`utils/date.js`:** Date formatting helpers. **`utils/time.js`:** Duration/time formatting.

---

## Server Architecture

> The server is written in **TypeScript** (`server/*.ts`, compiled to `dist/` via `tsc`) and is
> **multi-tenant**: a *master* PostgreSQL database holds the tenant catalog + platform tables,
> and each tenant gets its **own dedicated PostgreSQL database** with the full application schema.

### Multi-Tenant Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │  MASTER DB (DATABASE_URL)                    │
                       │  tenants, user_directory, platform_users,    │
                       │  app_settings, service_desk_tickets,         │
                       │  note_share_tokens, platform_audit_logs,     │
                       │  tenant_access_requests, _migrations         │
                       └──────────────┬───────────────────────────────┘
                                      │ tenant catalog (db_name, db_host, plan, status)
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
      ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
      │ wp_acme      │        │ wp_globex    │        │ wp_initech   │   ← one DB per tenant
      │ (full app    │        │ (full app    │        │ (full app    │     (users, tasks, chat,
      │  schema)     │        │  schema)     │        │  schema)     │      meetings, …)
      └──────────────┘        └──────────────┘        └──────────────┘
```

**Tenant resolution** (`middleware/tenant.ts` → `resolveTenant`) runs before auth on every request:

1. **JWT `tenant_id` claim** (fast path) — the token is verified once here and the decoded payload
   is stashed on `req.decodedToken` for reuse by the auth middleware (no double verify).
2. **Host header → custom domain** lookup in the master DB (Redis-cached 5 min, `SELECT *` so the
   cached record carries `plan`/`features` for plan gating).
3. **Fallback → master context** (platform admin panel, auth, health checks).

The resolved tenant's pool is attached as `req.db` (`query` / `transaction` / `pool`). Suspended
tenants get `503`; deleted tenants `404`. `requireFeature(name)` / `requireMinPlan(tier)` gate
routes on the tenant's plan + feature overrides (`utils/planCatalog.ts`).

**Pool strategy** (`utils/tenantManager.ts`): an LRU cache of at most `TENANT_MAX_POOLS` (default
10) tenant pools × `TENANT_POOL_SIZE` (default 8) connections, plus the master pool (10). Idle
pools are evicted after `TENANT_POOL_IDLE_MS` (default 5 min); eviction skips pools with in-flight
queries where possible. Worst case ≈ 90 connections — within Railway's ~97 limit.

**Tenant lifecycle**: `createTenant()` (catalog row → `CREATE DATABASE` → `initTenantSchema` →
org row), `suspendTenant` / `reactivateTenant`, `deleteTenant` (soft delete frees the slug and
retains the DB; hard delete drops it). `forEachTenant(fn)` iterates every active tenant for
background jobs, with per-tenant error isolation and optional legacy single-DB master coverage.

### Entry Point & Middleware Stack

```
server/index.ts
  │
  ├── dotenv → load .env
  ├── JWT_SECRET check (fatal if missing; ≥32 chars enforced in production)
  ├── Global crash handlers (unhandledRejection logged; uncaughtException → log + exit)
  │
  ├── MIDDLEWARE PIPELINE (in order):
  │   1. helmet()                  ← Security headers (CSP, HSTS in prod, frameguard)
  │   2. Permissions-Policy header ← camera, microphone, display-capture
  │   3. express.static(client/dist) ← Serve built React SPA (before CORS/auth)
  │   4. CORS (manual)            ← Same-origin auto-allow, env CORS_ORIGIN, workpulse:// (desktop), dev origins
  │   5. cookieParser()
  │   6. express.json()           ← 100kb default, 5mb for /notes, 10mb for /avatar
  │   7. requestLogger (pino)     ← Structured request logging with request IDs
  │   8. resolveTenant            ← Multi-tenant resolution (attaches req.tenant + req.db)
  │   9. Auth-gated /uploads      ← authMiddleware + path traversal + tenant/org isolation + SVG sandbox CSP
  │  10. /api/webhooks            ← mounted BEFORE CSRF (external services can't send the header)
  │  11. CSRF check               ← X-Requested-With: 'WorkPulse' on mutations
  │  12. impersonationAudit       ← audits every action during impersonation sessions
  │  13. maintenanceMode          ← 503 for non-platform-admins when active
  │
  ├── RATE LIMITERS (Redis-backed via lazy client resolution; MemoryStore without REDIS_URL):
  │   ├── authLimiter     (15/15min) → /api/auth, /api/auth/biometric/login (own bucket)
  │   ├── registerLimiter (10/15min) → /api/auth/register
  │   ├── forgotPwLimiter  (5/15min) → /api/auth/forgot-password
  │   ├── passwordLimiter (10/15min) → /api/profile/password
  │   └── apiLimiter    (5000/15min) → all other /api/* routes
  │   Keys are `tenantId:ip` (per-tenant isolation) with IPv6 /64 normalisation
  │   (ipKeyGenerator). passOnStoreError → fail open if the store backend dies.
  │
  ├── ROUTE MODULES (all prefixed /api):
  │   ├── /api/auth            → routes/auth.ts        (login, register, refresh, biometric, WebAuthn, MFA)
  │   ├── /api/tracker         → routes/tracker.ts     (clock in/out, analytics, manual entries, geo/face verification)
  │   ├── /api/leaves          → routes/leaves.ts
  │   ├── /api/tasks           → routes/tasks/         (kanban, backlog, comments, labels, history)
  │   ├── /api/sprints         → routes/sprints.ts
  │   ├── /api/agile           → routes/agile.ts       (work item types, workflow states, estimation config)
  │   ├── /api/profile         → routes/profile.ts
  │   ├── /api/org             → routes/organization.ts
  │   ├── /api/admin           → routes/admin.ts       (users, orgs, audit logs, invite codes, pay periods)
  │   ├── /api/admin/tenants   → routes/tenants.ts     (platform admin: tenant CRUD, plans, impersonation requests)
  │   ├── /api/platform-access → routes/platformAccess.ts (tenant-side JIT-access consent flow)
  │   ├── /api/internal        → routes/internal.ts    (platform_admin observability: ws-stats, pool stats)
  │   ├── /api/manager         → routes/manager.ts
  │   ├── /api/leave-policy    → routes/leavePolicy.ts
  │   ├── /api/notes           → routes/notes.ts
  │   ├── /api/calendar        → routes/calendar.ts
  │   ├── /api/meetings        → routes/meetings.ts
  │   ├── /api/notifications   → routes/notifications.ts
  │   ├── /api/export          → routes/export.ts
  │   ├── /api/chat            → routes/chat.ts
  │   ├── /api/giphy           → routes/giphy.ts       (GIF picker proxy)
  │   ├── /api/me/status       → routes/status.ts      (status service v2)
  │   ├── /api/search          → routes/search.ts
  │   ├── /api/service-desk    → routes/serviceDesk.ts (cross-tenant tickets → default tenant backlog)
  │   ├── /api/branding        → routes/branding.ts    (white-label: org logo, colors, email templates)
  │   ├── /api/custom-fields   → routes/customFields.ts
  │   ├── /api/compensation    → routes/compensation.ts (salary structures, payslips, payouts)
  │   ├── /api/projects        → routes/projects.ts    (Jira-style PROJ-123 issue keys)
  │   ├── /api/integrations    → routes/integrations.ts (per-org GitHub etc.)
  │   ├── /api/webhooks        → routes/webhooks.ts    (inbound, CSRF-exempt)
  │   ├── /api/public          → routes/public.ts      (unauthenticated share links, token-gated)
  │   └── /api/health          → DB ping; ?detail=true reports per-tenant migration status
  │
  ├── SPA FALLBACK           ← Serves index.html for non-file routes
  ├── ERROR HANDLER          ← 500 catch-all with structured logging
  │
  └── SERVER STARTUP (bootstrap(), memoised so it never runs twice):
      1. initDB()            ← Master schema + legacy tenant tables on master
      2. initRedis()         ← Connect Redis (optional, graceful degradation)
      3. sweepAllTenants()   ← Apply pending versioned migrations to every tenant DB
      4. http.createServer() + setupWebSocket() + createCollaborationServer() (/collab, Yjs)
      5. httpServer.listen(PORT)
      6. initJobs()          ← Start background job schedulers (BullMQ or setInterval)
      7. Graceful shutdown   ← SIGINT/SIGTERM: re-entry guarded; terminates WS clients,
                               closes HTTP server, then jobs → redis → tenant pools → master pool
```

### Database Migrations

Two complementary mechanisms keep every tenant DB schema current:

1. **`initTenantSchema()`** (`db.ts`) — the full idempotent base schema
   (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`). Run on tenant creation, and
   re-run for every tenant by `migrate.ts` on deploy (self-healing for partially-bootstrapped DBs).
2. **Versioned migrations** (`utils/migrationRunner.ts`) — an append-only `MIGRATIONS[]` registry
   tracked per-DB in the `_migrations` table. Applied by:
   - `migrate.ts` (runs before the server starts: `node migrate.js && node index.js`,
     with DB-readiness retry/backoff),
   - `sweepAllTenants()` on server bootstrap, and
   - first touch of a tenant pool at runtime (covers tenants provisioned mid-deploy).

Rules: append new migrations to the bottom of `MIGRATIONS[]`, never reorder or rename existing
entries, and make every migration idempotent so partial failures can be retried safely.

### Server Folder Structure

```
server/                            # TypeScript — compiled to dist/ by `npm run build`
├── index.ts                       # Express app + HTTP server + WS + startup/shutdown
├── migrate.ts                     # Standalone pre-start migration runner (retry/backoff)
├── db.ts                          # Master pool + initMasterDB() + initTenantSchema() (60+ tables)
├── redis.ts                       # Redis client (fail-fast reconnect), tenant-scoped cache helpers, Pub/Sub
├── jobs.ts                        # BullMQ queues / setInterval fallback (7 job families)
├── jest.setup.ts                  # Jest test setup
├── package.json
│
├── middleware/
│   ├── auth.ts                    # JWT verification (cookie or Bearer), token_version + session checks,
│   │                              #   impersonation revocation check (10s TTL cache)
│   ├── tenant.ts                  # resolveTenant / requireTenant / requireFeature / requireMinPlan /
│   │                              #   checkUserLimit / invalidateTenantCache
│   ├── rbac.ts                    # loadUserContext, requireRole, requireSameOrg, tenant-customisable
│   │                              #   role levels via tenant_roles (Redis-cached)
│   ├── impersonationAudit.ts      # Mirrors every impersonated action into platform_audit_logs
│   ├── maintenanceMode.ts         # Platform-wide 503 gate (app_settings driven)
│   └── agileEditor.ts             # Agile-config edit grants
│
├── routes/                        # 38 route modules — see the route table above. Highlights:
│   ├── auth.ts                    # Login (tenant + platform users), register, refresh, biometric,
│   │                              #   WebAuthn, forgot/reset password, MFA
│   ├── tenants.ts                 # Platform admin: tenant CRUD, plan changes, suspension,
│   │                              #   JIT-access request/impersonation flow
│   ├── platformAccess.ts          # Tenant-side approve/deny/revoke of access requests
│   ├── serviceDesk.ts             # Cross-tenant support tickets (master DB → default tenant backlog)
│   ├── billing/                   # Subscription/billing endpoints
│   ├── tasks/                     # Task router split by concern (kanban, backlog, comments, …)
│   └── …                          # tracker, leaves, sprints, agile, profile, organization, admin,
│                                  #   internal, manager, leavePolicy, notes, calendar, meetings,
│                                  #   notifications, export, chat, giphy, status, search, branding,
│                                  #   customFields, public, compensation, webhooks, projects, integrations
│
├── services/
│   ├── pushNotifications.ts       # FCM/Expo push (messages, call ring/cancel, alerts)
│   ├── chatMediaPipeline.ts       # Staged chat media processing (BullMQ-backed)
│   ├── sprintScheduler.ts         # Auto sprint create/start/complete + rollover
│   ├── razorpayPayout.ts          # Payroll payout integration
│   ├── github.ts                  # GitHub integration service
│   └── status/                    # Status service v2 (sessions, resolver, broadcaster, cache)
│
├── utils/
│   ├── ws.ts                      # WebSocket server (chat, calls, meetings, presence, relay authz)
│   ├── wsHandlers/, wsIdempotency.ts, wsValidate.ts, wsMetrics.ts
│   ├── tenantManager.ts           # Tenant DB lifecycle + LRU pool cache + forEachTenant
│   ├── migrationRunner.ts         # Versioned per-tenant migrations (MIGRATIONS[] + _migrations)
│   ├── collaboration.ts           # Yjs/Hocuspocus collaboration server (/collab)
│   ├── logger.ts                  # Pino structured logging + request logger + enrichLogger
│   ├── cookie.ts                  # JWT cookie options (strict; sameSite=none for desktop origin)
│   ├── audit.ts / platformAudit.ts # Tenant + platform audit log helpers
│   ├── approver.ts                # Approval chain resolution (manager → dept head → HR)
│   ├── impersonationApproval.ts   # JIT-access codes + synthetic Inspector users
│   ├── planCatalog.ts             # Plan tiers, feature flags, limits
│   ├── platformConfig.ts          # Platform-wide app_settings accessors
│   ├── password.ts, encryption.ts, mailer.ts, export.ts
│   ├── timeCalc.ts, timezone.ts, workDays.ts, attendance.ts
│   ├── geo.ts, face.ts            # Geofence + face-match attendance verification
│   ├── coturn.ts, hlsBroadcast.ts # TURN credentials, HLS meeting broadcast
│   ├── uploadPath.ts              # Canonical tenant-scoped upload paths
│   └── groupPerms.ts, meetingPermissions.ts, numberToWords.ts, salarySlipPdf.ts
│
├── types/                         # domain.ts (DbContext, TenantRow, …), express.d.ts (req augmentation)
├── uploads/                       # User-uploaded files (authenticated, tenant-isolated serving)
└── __tests__/                     # 47 test suites / 580+ tests (Jest + Supertest)
                                   #   routes, middleware, WS handlers (idempotency, relay authz,
                                   #   call flows), push payloads, plan gating, schedulers, utils
```

### Database Schema

The **master DB** holds platform tables (`tenants`, `user_directory`, `platform_users`,
`app_settings`, `service_desk_tickets`, `note_share_tokens`, `platform_audit_logs`,
`tenant_access_requests`). Every **tenant DB** gets the full application schema below, created by
`db.ts → initTenantSchema()` (idempotent) and evolved by `utils/migrationRunner.ts` (versioned,
tracked per-DB in `_migrations`). The diagram shows the core entities; additional tenant tables
cover agile customisation (`work_item_types`, `workflow_states`, `org_agile_settings`), device
push tokens, tenant roles, branding, custom fields, compensation, and projects/integrations.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CORE ENTITIES                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  organizations ──┬── departments ──── teams                                 │
│       │          │        │            │                                     │
│       │          │        └── head_id ─┘── lead_id                         │
│       │          │                     │                                     │
│       └──────────┴─── users ───────────┘                                   │
│                        │  (org_id, team_id, department_id, manager_id)      │
│                        │                                                    │
├────────────────────────┼────────────────────────────────────────────────────┤
│  TIME TRACKING         │                                                    │
│  time_entries ─────────┘ (clock_in, break_start, break_end, clock_out)     │
│    └── approval_status: pending/approved/rejected                          │
│    └── work_mode: office/remote/hybrid                                     │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  TASK MANAGEMENT                                                            │
│  tasks ───── task_labels (via task_label_map M:N)                          │
│    ├── task_comments                                                        │
│    ├── task_history (field-level change audit)                              │
│    └── sprints (team_id, planned/active/completed)                         │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  LEAVE MANAGEMENT                                                           │
│  leaves (per-day records, status: pending/approved/rejected/revoked)       │
│  leave_policies (org-level: annual_quota, accrual, carry-forward)          │
│  leave_balances (user × leave_type × year)                                 │
│  holidays (org-level holiday calendar)                                     │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  APPROVALS                                                                  │
│  approval_requests (type: leave/manual_entry/overtime/leave_withdraw)      │
│  role_change_requests (multi-approver JSON, pending/approved/rejected)     │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  CHAT & MESSAGING                                                           │
│  conversations ──── conversation_participants (is_pinned, is_favourite)    │
│       │                                                                     │
│       ├── messages (content, file attachments, reply_to, forwarded_from,   │
│       │            pinned, edited, deleted, format_type, delivered_to,      │
│       │            metadata)                                                │
│       ├── message_reads (per-user read cursor)                              │
│       ├── message_reactions (emoji toggle)                                  │
│       ├── starred_messages                                                  │
│       └── polls → poll_votes                                               │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  CALLS & MEETINGS                                                           │
│  call_logs (conversation-based: voice/video, ringing→answered→ended)      │
│  meetings (org-level: code, title, status, settings JSON, max_participants)│
│  meeting_participants (role, status: invited/joined/left)                   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  OTHER                                                                      │
│  calendar_events (user events, linked tasks/meetings)                      │
│  notebooks (per-user JSON blob)                                             │
│  notebook_history (page-level version snapshots)                           │
│  notifications (type, title, body, link_task_id, is_read)                  │
│  audit_logs (actor, action, entity, IP, user-agent)                        │
│  password_reset_tokens (expiry + used flag)                                │
│  app_settings (key-value: registration_mode, etc.)                         │
│  invite_codes (code, org, role, max_uses, expiry)                          │
│  task_labels (org-level color-coded labels)                                │
│  pay_periods (payroll locking by date range)                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key relationships:**
- `users` → `organizations`, `departments`, `teams` (tenant isolation via `org_id`)
- `tasks` → `users` (owner + assignee), `sprints`, `task_labels` (M:N)
- `conversations` → `organizations` (tenant-scoped), `messages`, `polls`, `call_logs`
- `meetings` → `organizations`, `conversations` (optional linked chat), `calendar_events`

### Authentication & Authorization

```
CLIENT                          SERVER
──────                          ──────
POST /api/auth/login     →      Resolve user via master user_directory (email/username → tenant)
                                 Verify credentials (bcrypt) against the tenant's users table
                                 (or platform_users for platform admins)
                                 Check account lockout (5 failed attempts → 15min lock)
                         ←      Set HttpOnly cookie: "token" (JWT)
                                 JWT payload: { id, username, tv (token_version),
                                                sid (session id), tenant_id, platform? }
                                 Native mobile clients receive the JWT in the body and send it
                                 back as `Authorization: Bearer <jwt>` instead of a cookie.

Every request:
  resolveTenant          →      middleware/tenant.ts: verify JWT once, attach req.tenant + req.db,
                                 stash payload on req.decodedToken

  Cookie/Bearer "token"  →      middleware/auth.ts:
                                   reuse req.decodedToken (or jwt.verify fallback)
                                   Check token_version vs DB (Redis-cached, 5 min)
                                   Check session id vs user_sessions (device enforcement)
                                   Check impersonation revocation (tenant_access_requests)
                                   Set req.userId, req.tenantId, req.isPlatformUser, …

                         →      middleware/rbac.ts:
                                   loadUserContext: req.userRole, req.userOrgId, req.roleLevel, etc.
                                   (Redis-cached user context, 1hr TTL; custom tenant roles
                                    resolved via tenant_roles → permission level 1..4)
                                   requireRole(minRole): permission-level check
                                   requireSameOrg: org membership / direct-reports check

CSRF protection:
  Header "X-Requested-With: WorkPulse" required on all mutation requests
  (/api/webhooks is mounted before the CSRF gate)

Token refresh:
  POST /api/auth/refresh →      Issue new JWT cookie (sliding window)
  Client auto-refreshes every 30 minutes via AuthContext

Password change/admin reset:
  Increments user.token_version → invalidates all existing JWTs + WebSockets

Additional login methods:
  Biometric device credential (desktop), WebAuthn passkeys, MFA — see routes/auth.ts

Platform admin → tenant access ("Just-In-Time Access with Tenant Consent"):
  1. Platform admin requests access (reason, scope, duration) → tenant_access_requests
  2. A tenant super_admin approves (one-time 6-digit code) or denies
  3. Admin redeems code + own password → bounded impersonation JWT
  4. Every action audited (impersonationAudit); tenant can revoke at any time
```

**Role hierarchy** (permission levels; tenants may define custom role keys pinned to levels 1–4):
```
employee(1) < team_lead(2) < manager(3) < hr_admin(4) < super_admin(5) < platform_admin(6)
```

| Route | Minimum Role | Special Rules |
|-------|-------------|---------------|
| `/api/admin/*` | hr_admin | super_admin for org management |
| `/api/manager/*` | team_lead | Or `has_reports` flag (any role with direct reports) |
| `/api/leave-policy/policies` | hr_admin | Read: all; Write: hr_admin+ |
| `/api/org/*` | employee | Write ops: hr_admin+ |
| All others | employee (authenticated) | Tenant-isolated via org_id |

### Rate Limiting

| Endpoint | Window | Max Requests | Store |
|----------|--------|-------------|-------|
| `/api/auth` (+ `/api/auth/biometric/login` on its own bucket) | 15 min | 15 | Redis / Memory |
| `/api/auth/register` | 15 min | 10 | Redis / Memory |
| `/api/auth/forgot-password` | 15 min | 5 | Redis / Memory |
| `/api/profile/password` | 15 min | 10 | Redis / Memory |
| All other `/api/*` | 15 min | 5000 | Redis / Memory |

Keys are `tenantId:ip` so one tenant can't exhaust another tenant's quota; IPv6 addresses are
normalised to their /64 subnet. When `REDIS_URL` is set, counters live in Redis (shared across
instances) with the client resolved lazily per command. `passOnStoreError` fails open if the
store backend errors.

### Background Jobs

All jobs iterate every active tenant via `forEachTenant()` (per-tenant error isolation).

| Job | Interval | Purpose |
|-----|----------|---------|
| **autoClockOut** | 5 min | Closes open sessions that rolled past local midnight — inserts `clock_out` at 23:59:59 of the session's own local day (per user timezone), batched to protect the pool |
| **cleanupTokens** | 1 hour | Deletes expired/used password reset tokens |
| **stale-call-sweep** | 20 sec | Force-ends calls stuck `ringing` > 30s (→ missed) or `answered` > 12h (→ ended); dismisses ring UI/push and clears in-call presence so abandoned calls can't pin users as "busy" |
| **sprint-lifecycle** | 1 hour | Auto-creates/starts/completes sprints for teams in auto mode + rolls over incomplete tickets |
| **inspector-prune** | 24 hours | Removes synthetic Platform Inspector users with no audit activity in 30 days |
| **retention-cleanup** | 24 hours | Purges audit/session logs past the retention policy; hard-deletes soft-deleted tenants past the cleanup window |
| **chat-media-pipeline** | on demand | Durable, retryable chat media processing (prepare → transform → upload → finalize) |

When Redis + BullMQ are available: jobs run as distributed BullMQ scheduled jobs (safe for multi-instance).
When Redis is unavailable: falls back to `setInterval` (single-instance mode).

### Redis Caching Layer

| Cache Key | TTL | Purpose |
|-----------|-----|---------|
| Token version | 5 min | Avoid DB lookups on every authenticated request |
| User context | 1 hour | Role, org_id, team_id cached for RBAC middleware |
| Org config | 24 hours | Organization settings |
| Search results | 2 min | Global search cache |
| Presence | 90 sec | User online/offline status |
| Sprint data | 5 min | Sprint configuration |
| Meeting participants | 30 min | Active meeting participant list |
| Unread counts | — | Per-user per-conversation unread message counters |

All cache operations **gracefully degrade** — if Redis is unavailable, the app falls back to direct DB queries.

---

## Real-Time Communication

### WebSocket Architecture

```
CLIENT (useWebSocket hook)          SERVER (utils/ws.js)
─────────────────────              ────────────────────
WebSocket connect              →   wss.on('connection')
  ws://host/ws                     │
  Auth via cookie JWT              ├── jwt.verify (cookie "token")
                                   ├── Check token_version
                                   ├── Register: clients.set(userId, Set<ws>)
                                   ├── Presence: mark online (Redis + DB.last_seen_at)
                                   └── broadcastPresence(userId, 'online')

ws.send(JSON)                  →   handleChatMessage(senderId, msg)
                                     switch(msg.type) → dispatch to handler

sendToUser(userId, type, data) ←   Delivers to all local WS connections for that user
                                   │
                                   └── Redis Pub/Sub: publish to 'ws:broadcast'
                                       (for multi-instance: other instances deliver locally)

Heartbeat: ping/pong every 30s     Auto-terminates dead connections

On disconnect:                 →   Remove from clients map
                                   Update last_seen_at
                                   broadcastPresence(userId, 'offline')
```

### Chat WebSocket Events

| Client → Server | Server → Client | Description |
|-----------------|-----------------|-------------|
| `chat_message` | `chat_message` | Send/receive messages. Server persists to `messages` table, broadcasts to all conversation participants, increments unread counts. |
| `chat_typing` | `chat_typing` | Typing indicator. Relayed to other conversation participants. |
| `chat_read` | — | Mark conversation as read. Updates `message_reads`, resets Redis unread counter. |
| — | `chat_mention` | Notification when @mentioned in a message. |

### Call WebSocket Events (WebRTC)

1:1 and small group voice/video calls. WebRTC signaling relayed via WebSocket.

| Client → Server | Server → Client | Description |
|-----------------|-----------------|-------------|
| `call_initiate` | `call_incoming` / `call_started` | Caller starts a call → creates `call_logs` entry (status: ringing). Participants receive `call_incoming`, caller receives `call_started`. |
| `call_accept` | `call_accepted` | Callee accepts → status changes to `answered`. Caller receives `call_accepted` (triggers WebRTC offer). |
| `call_reject` | `call_rejected` | Callee declines → status: `declined`. All participants notified. |
| `call_end` | `call_ended` | Either party ends → status: `ended` (or `missed` if was `ringing`). Duration calculated and stored. |
| `call_signal` | `call_signal` | WebRTC signaling relay (SDP offers/answers, ICE candidates). Server verifies both parties are in conversation, then forwards. |
| `call_reconnect` | `call_reconnect` | Page refresh during active call → other party prompted to re-offer. |
| `call_add_participant` | `call_incoming` | Add user to ongoing call (upgrade 1:1 to group). |

### Meeting WebSocket Events (WebRTC Mesh)

Multi-participant meeting rooms with WebRTC mesh topology.

| Client → Server | Server → Client | Description |
|-----------------|-----------------|-------------|
| `meeting_join` | `meeting_participant_joined` | Join meeting → upsert `meeting_participants`, activate meeting if scheduled. New joiner receives `existingPeers` list. All participants notified. |
| `meeting_leave` | `meeting_participant_left` | Leave meeting → status: `left`. If no active participants remain, meeting auto-ends. |
| `meeting_end` | `meeting_ended` | Organizer ends meeting → all participants receive `meeting_ended`, all marked as `left`. Duration calculated. |
| `meeting_signal` | `meeting_signal` | WebRTC mesh signaling (offer/answer/ICE) between meeting participants. |
| `meeting_chat` | `meeting_message` | In-meeting chat message (ephemeral, relayed to active participants). |
| `meeting_raise_hand` | `meeting_hand_raised` | Hand raise toggle → broadcast to all active participants. |
| `meeting_track_state` | `meeting_track_state` | Broadcast muted/videoOff/screenSharing state to other participants. |
| `meeting_mute_participant` | `meeting_muted` | Organizer remotely mutes a participant. |
| `meeting_add_participant` | `meeting_invite` | Organizer adds user → target receives `meeting_invite` with meeting code. |

### Presence

- **Online detection**: Set on WebSocket connect, removed on disconnect.
- **Redis key**: per-user presence flag with 90s TTL (heartbeat-refreshed).
- **DB fallback**: `users.last_seen_at` updated on connect/disconnect.
- **Broadcast**: `presence_update` event sent to all connected clients when a user's status changes.

---

## API Layer (Client)

`api.js` exports ~120 functions organized by domain. All requests include:
- `withCredentials: true` (sends HttpOnly JWT cookie)
- `X-Requested-With: WorkPulse` header (CSRF protection)
- `x-timezone-offset` header (user's local timezone offset)
- NProgress loading bar (auto start/done on request/response)

```
api.js function groups:
│
├── Auth (5)
│   login, logoutUser, refreshToken, forgotPassword, resetPassword
│
├── Tracker (14)
│   getStatus, clockIn, breakStart, breakEnd, clockOut,
│   getHistory, getAnalytics, getWidgets, getWeeklyChart, getTaskSummary,
│   addManualEntry, updateManualEntry, deleteEntries, getEntries,
│   getManualEntryRequests, submitOvertimeRequest, getOvertimeRequests
│
├── Theme (2)
│   getTheme, updateTheme
│
├── Leaves (5)
│   getLeaves, addLeave, addLeavesBatch, deleteLeave, withdrawLeave, getLeaveSummary
│
├── Tasks (18)
│   getTasks, addTask, updateTaskStatus, updateTask, deleteTask,
│   carryForwardTasks, getAssignableUsers, getTaskLabels,
│   getTaskComments, addTaskComment, updateTaskComment, deleteTaskComment,
│   getBacklog, addBacklogTask, scheduleTask, unscheduleTask,
│   getTaskDetail, getTaskHistory, searchTasks,
│   getAvailableSprints, assignTaskToSprint
│
├── Sprints (5)
│   getSprints, getActiveSprint, createSprint, updateSprint, deleteSprint, getSprintTasks
│
├── Profile (7)
│   getProfile, updateProfile, updateEmail, updatePassword,
│   deleteAccount, uploadAvatar, removeAvatar
│
├── Organization (15)
│   createOrg, getCurrentOrg, updateOrgSettings,
│   getOrgMembers, inviteToOrg, removeMember,
│   getOrgDepartments, createDepartment, updateDepartment, deleteDepartment,
│   getOrgTeams, createTeam, updateTeam, deleteTeam,
│   getTeamSprintConfig, updateTeamSprintConfig, getOrgChart
│
├── Admin (24)
│   getAdminOrganizations, getAdminOrganization, createAdminOrganization,
│   updateAdminOrganization, deleteAdminOrganization,
│   getAdminUsers, getAdminUser, createAdminUser, updateUserRole,
│   updateUserAssignment, toggleUserActive, deleteAdminUser, adminResetPassword,
│   getRoleChangeRequests, approveRoleChange, rejectRoleChange, cancelRoleChange,
│   getAuditLogs, getAdminStats,
│   getAdminTaskLabels, createAdminTaskLabel, updateAdminTaskLabel, deleteAdminTaskLabel,
│   importUsers, getPayPeriods, createPayPeriod, deletePayPeriod
│
├── Manager (11)
│   getTeamAttendance, getTeamAnalytics,
│   getApprovals, approveRequest, rejectRequest, bulkApproval,
│   getMyRequests,
│   getMemberHours, getMemberTasks, getMemberLeaves, getMemberRequests, getMemberOverview
│
├── Leave Policy (10)
│   getLeavePolicies, saveLeavePolicyAPI, deleteLeavePolicyAPI,
│   getLeaveBalances, getUserLeaveBalances, updateLeaveBalance,
│   getHolidays, addHoliday, addHolidaysBatch, deleteHoliday
│
├── Notes (4)
│   getNotes, saveNotes, getPageHistory, getHistorySnapshot
│
├── Calendar (4)
│   getCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent
│
├── Notifications (4)
│   getNotifications, markNotificationRead, markAllNotificationsRead, deleteNotification
│
├── Export (6)
│   exportMyAnalytics, exportMyLeaves, exportMyTasks,
│   exportTeamAnalytics, exportTeamLeaves, exportPayrollHours
│
├── Search (1)
│   globalSearch
│
├── Chat (27)
│   searchChatUsers, getPresence, getConversations, createConversation,
│   createGroup, updateGroup, getMembers, getMessages, markConversationRead,
│   getReadStatus, uploadChatFile, toggleReaction, editMessage, deleteMessage,
│   togglePin, getPinnedMessages, searchMessages, forwardMessage,
│   toggleStar, getStarredMessages, createPoll, votePoll, getPoll,
│   getSharedFiles, ackDelivered, deleteConversation, clearChat,
│   togglePinConversation, toggleFavouriteConversation,
│   getCallHistory, getAllCallHistory, getActiveCall
│
└── Meetings (9)
    createMeeting, checkMeetingConflicts, getMyMeetings, getMeeting,
    updateMeeting, cancelMeeting,
    getMeetingParticipants, addMeetingParticipant, removeMeetingParticipant
```

---

## Data Flow Diagrams

### Authentication Flow

```
┌──────────┐     POST /auth/login     ┌──────────┐     HttpOnly Cookie     ┌──────────┐
│  Login   │  ──────────────────────> │  Server  │  ─────────────────────> │  Browser │
│  Page    │  { username, password }   │  auth.js │  Set-Cookie: token=JWT │  Cookie  │
└──────────┘                          └──────────┘                         └──────────┘
     │                                                                          │
     └── AuthContext.saveAuth(user) ──> localStorage (display-safe fields only) │
                                                                                │
     Every API call:  Cookie auto-sent ────────────────────────────────────────┘
                      + X-Requested-With: WorkPulse (CSRF)
                      + x-timezone-offset (TZ)
```

### Real-Time Call Flow

```
Caller                          Server (ws.js)                     Callee
──────                          ──────────────                     ──────
call_initiate          →        Create call_log (ringing)
                                │
                                ├── call_incoming            →     GlobalIncomingCall overlay
                                └── call_started             →     (to caller)
                                
                                                                   User accepts →
                       ←        call_accepted                ←     call_accept
                                Update call_log (answered)

WebRTC SDP Offer       →        call_signal (relay)          →     Process offer
                       ←        call_signal (relay)          ←     WebRTC SDP Answer
ICE candidates         ↔        call_signal (relay)          ↔     ICE candidates

                                ── peer-to-peer stream active ──

call_end               →        Update call_log (ended)
                                Calculate duration
                                └── call_ended               →     Close peer connection
```

### Meeting Room Flow

```
                                 Server (ws.js)
Participant A                    ────────────────                  Participant B, C...
─────────────                                                      ───────────────
meeting_join           →         Upsert participant (joined)
                                 Activate meeting (if scheduled)
                       ←         meeting_participant_joined
                                   + existingPeers list           ← meeting_participant_joined
                                                                      (notification only)

For each existing peer:          
  meeting_signal (offer) →       Relay                     →      Process SDP offer
                         ←       Relay                     ←      meeting_signal (answer)
  ICE candidates         ↔       Relay                     ↔      ICE candidates

                                 ── WebRTC mesh: every peer connected to every other ──

meeting_track_state    →         Broadcast muted/video/screen      → (to all others)
meeting_raise_hand     →         Broadcast hand status              → (to all)
meeting_chat           →         Relay to active participants       → meeting_message
meeting_end            →         End meeting, mark all left         → meeting_ended
```

---

## CSS Architecture

The project uses **CSS Modules** for component-scoped styles (`.module.css` files) alongside a **global CSS** file (`global.css`) that defines CSS custom properties for theming.

### Global Theme Variables (`global.css`)

```css
:root (dark theme default)    |   [data-theme="light"]
──────────────────────────    |   ─────────────────────
--bg-primary: #0a0a12         |   --bg-primary: #f5f5f7
--bg-secondary: #12121a       |   --bg-secondary: #ffffff
--text: #f0f0f5               |   --text: #1a1a2e
--accent: #6366f1             |   --accent: #4f46e5
...                           |   ...
```

### CSS Module Organization

Each component/page has a co-located `.module.css` file. Admin styles use a shared hierarchy:

```
Admin.module.css (shared core)     ← layout, tabs, toolbar, table, badges, buttons
  │
  ├── AdminForms.module.css        ← modal, form groups, sections, inline inputs
  ├── AdminPages.module.css        ← page-specific admin layouts
  ├── AdminUtils.module.css        ← text utilities, layout containers
  ├── TaskLabels.module.css        ← label color picker + badge styles
  ├── AuditLogs.module.css         ← audit log table cell styles
  │
  ├── OrgChart.module.css          ← org chart cards, chips, badges
  └── TeamsConfig.module.css       ← sprint config form styles
```

**Import alias convention:**

| Alias | Module | Usage |
|-------|--------|-------|
| `s` | `Admin.module.css` | Shared admin styles |
| `sf` | `AdminForms.module.css` | Form/modal styles |
| `su` | `AdminUtils.module.css` | Utility classes |
| `tl` | `TaskLabels.module.css` | Label management |
| `al` | `AuditLogs.module.css` | Audit log table |
| `oc` | `OrgChart.module.css` | Org chart view |
| `tc` | `TeamsConfig.module.css` | Sprint config |
| `m` | `ManagerDashboard.module.css` | Manager dashboard |

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
| `Toast` | Any component via `useToast()` |
| `ConfirmDialog` | Tasks, Admin, Organization, Leaves |
| `SprintSelector` | Tasks, BacklogTab |
| `ExportButton` | Analytics, ManagerDashboard, Leaves |
| `MentionInput` | ChatInputBar, CommentSection |
| `ErrorBoundary` | App.jsx (wraps all routes) |

---

## Testing

### Client Tests (Vitest + React Testing Library)

```bash
cd client && npm test          # vitest run
```

11 test suites covering: AuthContext, Login, Navbar, Toast, ConfirmDialog, GlobalSearch, CalendarPage, Leaves, ManualEntry, TimerCard, NotesPage.

### Server Tests (Jest + Supertest)

```bash
cd server && npm test          # jest
```

47 test suites (580+ tests) covering route modules, tenant/auth/RBAC middleware, WebSocket
handlers (idempotency, relay authorization, call flows), push notification payloads, plan gating,
the sprint scheduler, and utilities (password, timeCalc, timezone, approver, geo, face, export).

---

## Build & Deployment

### Local Development

```bash
# Option 1: Separate terminals
cd client && npm run dev       # Vite dev server on :3000 (proxies /api → :5000)
cd server && npm run dev       # nodemon on :5000

# Option 2: Build script (production-like)
.\start-local.ps1              # Windows PowerShell
./start-local.sh               # Linux/macOS
```

### Production Build

```bash
cd client && npm run build     # → client/dist/ (Vite production build)
cd server && npm run build     # → server/dist/ (tsc compile)
cd server && node dist/migrate.js && node dist/index.js   # migrate, then serve API + static client on :5000
```

The Express server serves `client/dist/` via `express.static` and has an SPA fallback that serves `index.html` for all non-file routes.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `JWT_SECRET` | Yes | — | JWT signing secret |
| `PORT` | No | `5000` | Server port |
| `NODE_ENV` | No | — | `production` for production mode |
| `REDIS_URL` | No | — | Redis connection URL (optional) |
| `CORS_ORIGIN` | No | — | Comma-separated allowed origins |
| `TENANT_MAX_POOLS` | No | `10` | Max cached tenant DB pools (LRU) |
| `TENANT_POOL_SIZE` | No | `8` | Max connections per tenant pool |
| `TENANT_POOL_IDLE_MS` | No | `300000` | Idle tenant-pool eviction threshold (ms) |
| `DESKTOP_COOKIE_ORIGINS` | No | `workpulse://` | Origins allowed a cross-site auth cookie (Electron) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | No | — | Email sending config |
| `SMTP_FROM` | No | — | From address for emails |

### Docker

```bash
docker compose up              # Starts: app + postgres + redis
```

The `Dockerfile` uses a multi-stage build (install deps → build client → production image). The `Caddyfile` provides reverse proxy with automatic HTTPS for production deployment.
