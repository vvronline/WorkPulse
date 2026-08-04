# Graph Report - client  (2026-08-04)

## Corpus Check
- Large corpus: 408 files · ~1,010,058 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 2868 nodes · 6078 edges · 155 communities (141 shown, 14 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 44 edges (avg confidence: 0.61)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Leave and Holiday Management
- Meeting State Management
- Notification and Call Alerts
- Chat Realtime Collaboration
- Core API Operations
- Calendar Event Management
- Application Infrastructure
- Rich Text Editor
- Emoji and GIF Picker
- Task Detail Management
- Navigation and Notifications
- Profile Search and Mentions
- Authentication and Biometrics
- Organization Structure Management
- Task Backlog Interface
- Notes Folder Management
- Manual Time Entries
- TypeScript Compiler Configuration
- Notes Export and Templates
- Admin User Management
- Meeting Room Interface
- Branding and App Contexts
- User Presence Status
- Notes Navigation Tools
- Testing Dependencies
- Agile Task Criteria
- Notes History and Properties
- Chat Message Interactions
- Conversation Interface
- Frontend Runtime Dependencies
- Sprint Workflow Management
- Notes Capture Tools
- Password and Policy Forms
- Call Control Icons
- Agile Workflow Settings
- Team Analytics Dashboard
- Attendance Timer Dashboard
- Notes Editor Extensions
- Compensation and Bank Setup
- Project Management
- Platform Access Requests
- Live Attendance Tracking
- Organization Task Labels
- Office Location Settings
- User Role Administration
- Node TypeScript Configuration
- Payroll and Salary Processing
- Platform Announcements and Settings
- Organization Role Labels
- Chat Message Actions
- Analytics Dashboard Widgets
- Sprint Insights
- Chat File Previews
- Meeting Connection Preflight
- Team Sprint Management
- Tenant Detail Administration
- Task Selectors and Types
- Video Call Overlay
- Chat Timeline Messages
- Daily Notes Home
- Common Error Handling
- Group Chat Management
- Tenant Creation and Plans
- Chat Media Composer
- Clock In Verification
- Message Formatting Tools
- Notes Linked Entities
- Conversation and Call Actions
- Administrative Audit Logs
- Tenant Access and Impersonation
- Dashboard Events and Reminders
- Attendance History Calendar
- Authentication Session Context
- GitHub Repository Integration
- Service Desk Tickets
- Analytics Distribution Charts
- Peer Activity Status
- Shared Chat Files
- Meeting Participant Selection
- Chat Scroll Positioning
- Agile Configuration Context
- User Profile Menu
- Custom Field Administration
- Notes Reports and Modals
- Task Custom Fields
- Team Attendance Members
- Organization Work Settings
- Face Capture Verification
- Notes Todo Board
- Pending Approval Requests
- Call Signaling State
- Email Template Management
- Notes Markdown Conversion
- Package Build Scripts
- Desktop Icon Generation
- Task Backlog Operations
- Member Request Management
- Today's Calendar Events
- Web App Manifest
- Employee Salary Slips
- Member Hours Overview
- Dashboard Tasks and Timeline
- Member Status Overview
- Vite Environment Types
- Platform User Administration
- Impersonation Session Banner
- Member Leave Approvals
- Bulk User Import
- WebRTC Media Connections
- Message Reactions
- Notes Editor Context Menu
- Event Reminder Toasts
- Leave Page Tests
- Emoji Sprite Categories
- Package Metadata
- Face Model Assets
- Call History Management
- Manager Request Dashboard
- Notes Persistence
- Sprint Notes Embed
- Tenant Platform Overview
- Meeting HLS Broadcast
- React Error Boundary
- Picture in Picture Calls
- MediaPipe Runtime Assets
- Face Enrollment
- Conversation Call History
- Platform Audit Overview
- Calendar Task Page
- Shared Notes Access
- Custom Fields Context
- Chat Message Search
- In Call Chat Panel
- Small App Icon
- Large App Icon
- Payment Provider Settings
- Pinned Chat Messages
- Call Device Widgets
- Call Controls Hook
- Polling Interval Constants
- Application HTML Shell
- Service Worker Cache
- HLS Meeting Viewer
- PDF Export Dependency
- Math Rendering Dependency
- Map Rendering Dependency
- React Map Integration
- WebAuthn Browser Dependency
- Query Storage Persistence
- React Query Dependency
- Persistent React Queries
- Collaborative Editing Dependency
- Platform Inspector Shield

## God Nodes (most connected - your core abstractions)
1. `useAuth()` - 111 edges
2. `useAutoDismiss()` - 51 edges
3. `useNotesStore()` - 31 edges
4. `useAgileConfig()` - 28 edges
5. `useChatState()` - 27 edges
6. `compilerOptions` - 25 edges
7. `NoteFolder` - 24 edges
8. `Tasks()` - 24 edges
9. `getCurrentOrg()` - 23 edges
10. `getLocalToday()` - 22 edges

## Surprising Connections (you probably didn't know these)
- `VersionHistory()` --references--> `dompurify`  [EXTRACTED]
  src/components/DailyNotes/components/VersionHistory.tsx → package.json
- `MemberChip()` --references--> `dompurify`  [EXTRACTED]
  src/components/organization/OrgChartView.tsx → package.json
- `highlightHtml()` --references--> `dompurify`  [EXTRACTED]
  src/pages/tasks/utils.tsx → package.json
- `stripHtml()` --references--> `dompurify`  [EXTRACTED]
  src/pages/tasks/utils.tsx → package.json
- `Probe()` --references--> `react`  [EXTRACTED]
  src/status/__tests__/StatusContext.spec.tsx → package.json

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Server-Resolved Status Delivery Flow** — client_src_status_readme_server_status_resolver, client_src_status_readme_user_status_event, client_src_status_readme_statuscontext, client_src_status_readme_usestatus [EXTRACTED 1.00]
- **User Status Update Flow** — client_src_status_readme_statuspicker, client_src_status_readme_rest_status_api, client_src_status_readme_server_status_resolver [EXTRACTED 1.00]
- **Visual Emoji Categories** — client_public_emoji_sprite_national_flags, client_public_emoji_sprite_people_and_faces, client_public_emoji_sprite_gestures_and_body_parts, client_public_emoji_sprite_objects_food_and_activities, client_public_emoji_sprite_symbols_and_interface_icons [EXTRACTED 1.00]
- **Three Interlocking Colored Loops** — client_public_icon_192_yellow_rounded_loop, client_public_icon_192_cyan_rounded_loop, client_public_icon_192_green_rounded_loop [EXTRACTED 1.00]
- **Three-Color Interlocking Mark** — client_public_icon_512_yellow_vertical_loop, client_public_icon_512_blue_diagonal_loop, client_public_icon_512_green_diagonal_loop [EXTRACTED 1.00]

## Communities (155 total, 14 thin omitted)

### Community 0 - "Leave and Holiday Management"
Cohesion: 0.05
Nodes (58): addHoliday(), addLeave(), addLeavesBatch(), deleteHoliday(), deleteLeavePolicyAPI(), exportMyLeaves(), getHolidays(), getLeaveBalances() (+50 more)

### Community 1 - "Meeting State Management"
Cohesion: 0.05
Nodes (55): ADR-0008, getMeetingMessages(), describeState(), MeetingEvent, MeetingState, nextState(), Severity, StateDescription (+47 more)

### Community 2 - "Notification and Call Alerts"
Cohesion: 0.05
Nodes (55): getNotificationPrefs(), updateNotificationPrefs(), useGlobalCall(), DragState, GlobalIncomingCall(), NotificationSoundsModal(), NotificationSoundsModalProps, TonePreset (+47 more)

### Community 3 - "Chat Realtime Collaboration"
Cohesion: 0.06
Nodes (52): ackDelivered(), createConversation(), getConversations(), getMessages(), getPresence(), getReadStatus(), markConversationRead(), AnyState (+44 more)

### Community 4 - "Core API Operations"
Cohesion: 0.03
Nodes (6): AnyData, ClockInPayload, getPublicNote(), GiphyMedia, Params, PublicNote()

### Community 5 - "Calendar Event Management"
Cohesion: 0.05
Nodes (56): checkMeetingConflicts(), createCalendarEvent(), createMeeting(), deleteBrandingLogo(), deleteCalendarEvent(), getBranding(), updateBrandingAccent(), updateCalendarEvent() (+48 more)

### Community 6 - "Application Infrastructure"
Cohesion: 0.06
Nodes (42): API, getActiveInspectorSession(), revokeAccessSession(), App(), AppRoutes(), CallPipPage, CatchAll(), FaceEnrollment (+34 more)

### Community 7 - "Rich Text Editor"
Cohesion: 0.06
Nodes (23): CodeBlockLanguagePicker(), CodeBlockLanguagePickerProps, getEditor(), LANG_LABEL, PickerState, readLang(), AudioBlot, baseModules (+15 more)

### Community 8 - "Emoji and GIF Picker"
Cohesion: 0.09
Nodes (41): searchGiphy(), EmojiCell(), EmojiGifPicker(), EmojiGifPickerProps, PickerMode, TenorItem, CURATED_EMOJI, HAS_BUNDLED_ASSETS (+33 more)

### Community 9 - "Task Detail Management"
Cohesion: 0.10
Nodes (36): addTaskComment(), carryForwardTasks(), deleteTask(), deleteTaskComment(), getAssignableUsers(), getAvailableSprints(), getProjects(), getSprintStats() (+28 more)

### Community 10 - "Navigation and Notifications"
Cohesion: 0.08
Nodes (31): deleteNotification(), getNotifications(), markAllNotificationsRead(), markNotificationRead(), ChatContextValue, ChatCtx, ChatProvider(), UnreadConversation (+23 more)

### Community 11 - "Profile Search and Mentions"
Cohesion: 0.06
Nodes (32): dompurify, dompurify, globalSearch(), MentionInput(), MentionInputProps, MentionUser, MemberChip(), COMMENT_QUILL_MODULES (+24 more)

### Community 12 - "Authentication and Biometrics"
Cohesion: 0.12
Nodes (32): biometricEnroll(), biometricLogin(), deleteAccount(), listBiometricDevices(), login(), revokeBiometricDevice(), updatePassword(), updateProfile() (+24 more)

### Community 13 - "Organization Structure Management"
Cohesion: 0.08
Nodes (29): createAdminOrganization(), createDepartment(), deleteAdminOrganization(), deleteDepartment(), getOrgChart(), updateAdminOrganization(), updateDepartment(), DepartmentRow (+21 more)

### Community 14 - "Task Backlog Interface"
Cohesion: 0.12
Nodes (31): getLocalToday(), BacklogTab(), BacklogTabProps, getPriority(), ColumnDef, COLUMNS, COMMENT_QUILL_MODULES, PRIORITIES (+23 more)

### Community 15 - "Notes Folder Management"
Cohesion: 0.09
Nodes (26): FolderManager(), FolderManagerProps, FolderNodeProps, CreateRowProps, DragInfo, DragType, FolderNodeProps, FolderTree() (+18 more)

### Community 16 - "Manual Time Entries"
Cohesion: 0.08
Nodes (33): addManualEntry(), getEntries(), getManualEntryRequests(), getOvertimeRequests(), submitOvertimeRequest(), updateManualEntry(), BreakItem, isLiveActiveSession() (+25 more)

### Community 17 - "TypeScript Compiler Configuration"
Cohesion: 0.06
Nodes (35): DOM, DOM.Iterable, ES2022, src, vite/client, vite-env.d.ts, compilerOptions, allowImportingTsExtensions (+27 more)

### Community 18 - "Notes Export and Templates"
Cohesion: 0.12
Nodes (32): convertToTask(), getDailyPrefill(), getMentionableUsers(), getOneOnOnePrefill(), sendNoteMention(), buildPrintable(), downloadBlob(), downloadPdf (+24 more)

### Community 19 - "Admin User Management"
Cohesion: 0.10
Nodes (32): createAdminUser(), getAdminOrganizations(), getAdminStats(), getAdminUsers(), getOrgDepartments(), getOrgTeams(), getRoleChangeRequests(), AddPeopleWizard() (+24 more)

### Community 20 - "Meeting Room Interface"
Cohesion: 0.09
Nodes (25): getMeeting(), GlobalMeetingRoom(), DragState, MeetingPiP(), JoinMeetingArgs, MeetingContextValue, MeetingCtx, MeetingProvider() (+17 more)

### Community 21 - "Branding and App Contexts"
Cohesion: 0.09
Nodes (28): getPublicBranding(), getTheme(), updateTheme(), Branding, BrandingContext, BrandingContextValue, BrandingProvider(), CallContextValue (+20 more)

### Community 22 - "User Presence Status"
Cohesion: 0.11
Nodes (27): StatusPicker(), getMyStatus(), sendActivityPing(), setMyStatus(), SetMyStatusBody, setPresencePreference(), ACTIVITY_PING_THROTTLE_MS, EFFECTIVE_STATUSES (+19 more)

### Community 23 - "Notes Navigation Tools"
Cohesion: 0.09
Nodes (27): BacklinksPanel(), BacklinksPanelProps, Breadcrumbs(), BreadcrumbsProps, CommandPalette(), CommandPaletteProps, fuzzyMatch(), FuzzyResult (+19 more)

### Community 24 - "Testing Dependencies"
Cohesion: 0.06
Nodes (33): emoji-datasource-apple, jsdom, devDependencies, emoji-datasource-apple, jsdom, @testing-library/dom, @testing-library/jest-dom, @testing-library/react (+25 more)

### Community 25 - "Agile Task Criteria"
Cohesion: 0.12
Nodes (26): useAgileConfig(), getAcceptanceCriteria(), updateAcceptanceCriteria(), AcceptanceCriteria(), AcceptanceCriteriaProps, CriterionItem, BlockerBadge(), BlockerBadgeProps (+18 more)

### Community 26 - "Notes History and Properties"
Cohesion: 0.10
Nodes (23): getHistorySnapshot(), getPageHistory(), getTimeSummary(), DrawioEditor(), DrawioEditorProps, PagePropertiesPanel(), PagePropertiesPanelProps, PRIORITY_OPTIONS (+15 more)

### Community 27 - "Chat Message Interactions"
Cohesion: 0.08
Nodes (20): getPoll(), votePoll(), ContextMenu(), ContextMenuItem, ContextMenuProps, ChatMsg, DeliveryStatus(), DeliveryStatusProps (+12 more)

### Community 28 - "Conversation Interface"
Cohesion: 0.14
Nodes (23): ChatAvatar(), Chat(), ChatHeader(), ChatHeaderProps, OverflowItem, STATUS_DOT_COLOR, STATUS_LABEL, WORK_MODE_COLOR (+15 more)

### Community 29 - "Frontend Runtime Dependencies"
Cohesion: 0.07
Nodes (29): axios, chart.js, highlight.js, @hocuspocus/provider, lucide-react, @mediapipe/selfie_segmentation, nprogress, dependencies (+21 more)

### Community 30 - "Sprint Workflow Management"
Cohesion: 0.10
Nodes (28): addTaskDependency(), completeSprint(), getRecentVelocity(), getSprintBurndown(), getSprints(), getTaskChildren(), getTaskDependencies(), getTaskParent() (+20 more)

### Community 31 - "Notes Capture Tools"
Cohesion: 0.10
Nodes (21): AudioRecorder(), AudioRecorderProps, formatTime(), Phase, pickMimeType(), PageLinkPicker(), PageLinkPickerProps, QuickCapture() (+13 more)

### Community 32 - "Password and Policy Forms"
Cohesion: 0.13
Nodes (19): adminResetPassword(), forgotPassword(), resetPassword(), saveLeavePolicyAPI(), updateEmail(), AsyncActionMessage, useAsyncAction(), useAutoDismiss() (+11 more)

### Community 33 - "Call Control Icons"
Cohesion: 0.12
Nodes (19): AddParticipantIcon(), CamIcon(), CamOffIcon(), ChatIcon(), EmojiIcon(), HoldIcon(), MicIcon(), MicOffIcon() (+11 more)

### Community 34 - "Agile Workflow Settings"
Cohesion: 0.12
Nodes (24): createWorkflowState(), createWorkItemType(), deleteWorkflowState(), deleteWorkItemType(), getAgilePermissions(), getAgileSettings(), getWorkflowStates(), getWorkItemTypes() (+16 more)

### Community 35 - "Team Analytics Dashboard"
Cohesion: 0.14
Nodes (19): exportTeamAnalytics(), getLocalDate(), getTeamAnalytics(), formatMin(), LEAVE_ICONS, STATUS_COLORS, MemberExpandedCard(), MemberExpandedCardProps (+11 more)

### Community 36 - "Attendance Timer Dashboard"
Cohesion: 0.15
Nodes (17): ClockInVerifyModal(), WeeklyChart, WeeklyData, WeeklyDay, WorkTimerCard(), FloatingTimer(), HistoryDay, HistoryTable() (+9 more)

### Community 37 - "Notes Editor Extensions"
Cohesion: 0.12
Nodes (20): commitToQuill(), ImageResizer(), SelState, getEditor(), MentionMenu(), MentionMenuProps, MentionUser, fileToDataUrl() (+12 more)

### Community 38 - "Compensation and Bank Setup"
Cohesion: 0.13
Nodes (23): approveBankDetails(), assignCompensation(), createCompensationTemplate(), deleteCompensationTemplate(), getBankVerifications(), getCompensationTemplates(), getCtcConfig(), getEmployeeCompensations() (+15 more)

### Community 39 - "Project Management"
Cohesion: 0.10
Nodes (20): archiveProject(), createProject(), deleteProject(), getProjectTasks(), updateProject(), Pagination(), PaginationProps, styles (+12 more)

### Community 40 - "Platform Access Requests"
Cohesion: 0.11
Nodes (21): approveAccessRequest(), denyAccessRequest(), listIncomingAccessRequests(), alertStyle(), badgeWarn, btn, cardStyle, closeBtn (+13 more)

### Community 41 - "Live Attendance Tracking"
Cohesion: 0.17
Nodes (20): breakEnd(), breakStart(), clockIn(), clockOut(), getStatus(), getWeeklyChart(), CONFETTI_PIECES, _confettiColors (+12 more)

### Community 42 - "Organization Task Labels"
Cohesion: 0.13
Nodes (19): createOrg(), createTaskLabel(), deleteTaskLabel(), getCurrentOrg(), getTaskLabelsManage(), updateTaskLabel(), AdminPanel(), GROUP_ORDER (+11 more)

### Community 43 - "Office Location Settings"
Cohesion: 0.12
Nodes (18): defaultIcon, OfficeLocationSettings(), OfficeLocationSettingsProps, OrgData, SearchResult, WifiAp, ElectronLocationResult, GeolocationError (+10 more)

### Community 44 - "User Role Administration"
Cohesion: 0.14
Nodes (17): approveRoleChange(), cancelRoleChange(), deleteAdminUser(), rejectRoleChange(), toggleUserActive(), updateUserAssignment(), updateUserRole(), AssignmentModalProps (+9 more)

### Community 45 - "Node TypeScript Configuration"
Cohesion: 0.10
Nodes (20): ES2023, compilerOptions, allowImportingTsExtensions, allowJs, isolatedModules, lib, module, moduleDetection (+12 more)

### Community 46 - "Payroll and Salary Processing"
Cohesion: 0.16
Nodes (19): bulkPublishSlips(), createPayPeriod(), deletePayPeriod(), disburseSalaries(), downloadSalarySlipPdf(), exportPayrollHours(), getDisbursements(), getPayPeriods() (+11 more)

### Community 47 - "Platform Announcements and Settings"
Cohesion: 0.16
Nodes (18): createAnnouncement(), deleteAnnouncement(), getAdminAnnouncements(), getPlatformConfig(), updateAnnouncement(), updateImpersonationPolicy(), updatePlatformConfig(), Announcement (+10 more)

### Community 48 - "Organization Role Labels"
Cohesion: 0.13
Nodes (19): createOrgRole(), deleteOrgRole(), getOrgRoles(), updateOrgRole(), AddDraft, EMPTY_ROLES, OrgRoleLabels(), OrgRoleLabelsProps (+11 more)

### Community 49 - "Chat Message Actions"
Cohesion: 0.16
Nodes (18): cancelChatMediaJob(), createPoll(), deleteMessage(), editMessage(), getStarredMessages(), retryChatMediaJob(), togglePin(), toggleReaction() (+10 more)

### Community 50 - "Analytics Dashboard Widgets"
Cohesion: 0.13
Nodes (15): exportMyAnalytics(), getAnalytics(), getNotificationMetrics(), getWidgets(), ExportButton(), ExportButtonProps, WidgetsData, WidgetsGrid (+7 more)

### Community 51 - "Sprint Insights"
Cohesion: 0.13
Nodes (14): getSprintCumulativeFlow(), getSprintCycleTime(), getSprintRetrospective(), getSprintTasks(), updateSprintRetrospective(), EMPTY_SPRINTS, EMPTY_TASKS, PRIORITY_COLORS (+6 more)

### Community 52 - "Chat File Previews"
Cohesion: 0.13
Nodes (15): markMessageViewed(), serverURL, audioDurationCache, AudioPlayer(), AudioPlayerProps, FilePreview(), FilePreviewProps, FileTypeIcon() (+7 more)

### Community 53 - "Meeting Connection Preflight"
Cohesion: 0.15
Nodes (10): ADR-0010, getIceConfig(), PreflightOptions, PreflightResult, PreflightSummary, runPreflight(), summarisePreflight(), DeviceLists (+2 more)

### Community 54 - "Team Sprint Management"
Cohesion: 0.16
Nodes (18): createTeam(), deleteTeam(), getActiveSprint(), getOrgMembers(), getTeamSprintConfig(), pauseSprint(), resumeSprint(), updateTeam() (+10 more)

### Community 55 - "Tenant Detail Administration"
Cohesion: 0.19
Nodes (16): deleteTenantApi(), getTenant(), getTenantStats(), getTenantUsers(), reactivateTenant(), suspendTenant(), updateTenant(), updateTenantDomain() (+8 more)

### Community 56 - "Task Selectors and Types"
Cohesion: 0.15
Nodes (16): AuthContextValue, SprintSelector(), SprintSelectorProps, LabelSelector(), LabelSelectorProps, TaskContextValue, TaskProviderProps, ChatMessage (+8 more)

### Community 57 - "Video Call Overlay"
Cohesion: 0.11
Nodes (3): CallOverlayProps, DeviceSelectorProps, ICE_SERVERS

### Community 58 - "Chat Timeline Messages"
Cohesion: 0.15
Nodes (15): MeetingCard(), MeetingCardMsg, MeetingCardProps, formatDuration(), ICON_MAP, SystemMessage(), SystemMessageProps, SystemMsg (+7 more)

### Community 59 - "Daily Notes Home"
Cohesion: 0.18
Nodes (16): getGreeting(), NotesHome(), NotesHomeProps, relativeFromNow(), snippetOf(), todayLong(), TagEditor(), TagEditorProps (+8 more)

### Community 60 - "Common Error Handling"
Cohesion: 0.14
Nodes (13): react, react, ErrorBoundaryProps, ErrorBoundaryState, ToastApi, ToastContext, ToastContextValue, ToastItem (+5 more)

### Community 61 - "Group Chat Management"
Cohesion: 0.15
Nodes (15): createGroup(), forwardMessage(), leaveGroup(), setGroupRole(), transferGroupOwner(), updateGroup(), ChatAvatarProps, STATUS_CONFIG (+7 more)

### Community 62 - "Tenant Creation and Plans"
Cohesion: 0.18
Nodes (15): createTenant(), createTenantUser(), getPlanCatalog(), resetPlanCatalog(), seedTenant(), updatePlanCatalog(), CreateTenant(), CreateTenantProps (+7 more)

### Community 63 - "Chat Media Composer"
Cohesion: 0.15
Nodes (15): getLinkPreview(), CameraCapture(), CameraCaptureProps, EditItem, loadImage(), MediaEditor(), MediaEditorProps, MediaEditorResult (+7 more)

### Community 64 - "Clock In Verification"
Cohesion: 0.14
Nodes (16): classifySubmitErr(), ClockInPayload, ClockInVerifyModalProps, FACE_CODES, LOCATION_CODES, LocErrState, normaliseBssid(), OrgWifiState (+8 more)

### Community 65 - "Message Formatting Tools"
Cohesion: 0.12
Nodes (11): CodeBlock(), CodeBlockProps, FormatAction, FormatToolbarProps, MessageContent(), MessageContentProps, PollCreator(), PollCreatorProps (+3 more)

### Community 66 - "Notes Linked Entities"
Cohesion: 0.16
Nodes (13): addNoteLink(), getNoteLinks(), removeNoteLink(), searchNoteEvents(), searchNoteMeetings(), searchNoteTasks(), CtxMenu, EntityType (+5 more)

### Community 67 - "Conversation and Call Actions"
Cohesion: 0.21
Nodes (14): blockUser(), deleteConversation(), getMembers(), muteConversation(), toggleArchiveConversation(), toggleFavouriteConversation(), togglePinConversation(), unblockUser() (+6 more)

### Community 68 - "Administrative Audit Logs"
Cohesion: 0.17
Nodes (16): getAuditLogs(), ACTIONS, ActorOption, AuditLog, AuditLogs(), chipStyle(), DATE_RANGES, dateInputStyle (+8 more)

### Community 69 - "Tenant Access and Impersonation"
Cohesion: 0.17
Nodes (11): cancelAccessRequest(), createTenantAccessRequest(), getImpersonationPolicy(), impersonateTenant(), listTenantAccessRequests(), AccessRequest, Policy, RequestAccessModal() (+3 more)

### Community 70 - "Dashboard Events and Reminders"
Cohesion: 0.21
Nodes (13): getActiveAnnouncements(), getCalendarEvents(), getTaskSummary(), Reminder, REMINDER_SCHEDULE, useEventReminder(), Dashboard(), DASHBOARD_QUERY_KEY (+5 more)

### Community 71 - "Attendance History Calendar"
Cohesion: 0.17
Nodes (13): getHistory(), getLeaves(), Analytics, AttendanceCalendar(), AttendanceCalendarProps, buildMonthMatrix(), EMPTY, fmtYMD() (+5 more)

### Community 72 - "Authentication Session Context"
Cohesion: 0.20
Nodes (14): getProfile(), logoutUser(), refreshToken(), AuthContext, AuthProvider(), clearTenantScopedCaches(), SAFE_CACHE_FIELDS, sanitizeForCache() (+6 more)

### Community 73 - "GitHub Repository Integration"
Cohesion: 0.16
Nodes (13): connectGithubRepos(), disconnectGithub(), disconnectGithubRepo(), getGithubStatus(), listGithubRepos(), startGithubOAuth(), EMPTY_REPOS, GitHubIntegration() (+5 more)

### Community 74 - "Service Desk Tickets"
Cohesion: 0.22
Nodes (14): createServiceDeskTicket(), deleteServiceDeskTicket(), getServiceDeskStats(), getServiceDeskTickets(), EMPTY_TICKETS, getPriority(), getStatus(), getTicketType() (+6 more)

### Community 75 - "Analytics Distribution Charts"
Cohesion: 0.21
Nodes (11): axisStyle, legendStyle, tooltipStyle, TimeDistributionChart(), TimeDistributionChartProps, WorkModeChart(), WorkModeChartProps, TrendChart() (+3 more)

### Community 76 - "Peer Activity Status"
Cohesion: 0.16
Nodes (14): Idle Activity Ping, Append-Only Peer Status History, Effective Status, Inconsistent Status UI, Legacy UserStatusContext, Peer Status Map, REST Status API, Server-Authoritative Status (+6 more)

### Community 77 - "Shared Chat Files"
Cohesion: 0.23
Nodes (12): getSharedFiles(), FILE_FILTERS, FileGroups, getFileCategory(), groupByDate(), SharedFile, SharedFilesPanel(), SharedFilesPanelProps (+4 more)

### Community 78 - "Meeting Participant Selection"
Cohesion: 0.18
Nodes (11): searchChatUsers(), MeetingParticipantPicker(), AddParticipantPopup(), AddParticipantPopupProps, CallOverlay(), MentionInput(), MentionInputHandle, MentionInputProps (+3 more)

### Community 79 - "Chat Scroll Positioning"
Cohesion: 0.18
Nodes (7): NEAR_BOTTOM_PX, PIN_SETTLE_MS, NOTE: deliberately no bail-out on an empty thread. Combining that, ScrollPin, ScrollPinOptions, useScrollPin(), renderPin()

### Community 80 - "Agile Configuration Context"
Cohesion: 0.21
Nodes (12): AgileConfig, AgileConfigContext, AgileConfigContextValue, AgileConfigProvider(), AgileSettings, FALLBACK_CONFIG, loadCache(), PriorityScheme (+4 more)

### Community 81 - "User Profile Menu"
Cohesion: 0.22
Nodes (11): baseURL, removeAvatar(), uploadAvatar(), Glyph, ProfileMenu(), StatusMeta, useTheme(), useWorkState() (+3 more)

### Community 82 - "Custom Field Administration"
Cohesion: 0.21
Nodes (12): createCustomField(), deleteCustomField(), getCustomFieldsAll(), updateCustomField(), blankForm, CustomFieldForm, CustomFieldsSection(), CustomFieldsSectionProps (+4 more)

### Community 83 - "Notes Reports and Modals"
Cohesion: 0.21
Nodes (9): getDirectReports(), NotesHeader(), NotesHeaderProps, NotesModal(), NotesModalProps, ReportPickerModal(), ReportPickerModalProps, DailyNotes() (+1 more)

### Community 84 - "Task Custom Fields"
Cohesion: 0.21
Nodes (10): getTaskCustomFieldValues(), updateTaskCustomFieldValues(), CustomFieldDefinition, CustomFieldsEditor(), CustomFieldsEditorProps, CustomFieldsSummary(), FieldOption, FieldValue (+2 more)

### Community 85 - "Team Attendance Members"
Cohesion: 0.18
Nodes (10): getTeamAttendance(), ROLE_LABELS, LeaveIconForProps, Member, MemberCard(), MemberCardProps, EMPTY, TeamAttendance() (+2 more)

### Community 86 - "Organization Work Settings"
Cohesion: 0.22
Nodes (10): updateOrgSettings(), OrgData, OrgSettings(), OrgSettingsProps, parseWorkDaysToSet(), setToCsv(), WEEK_DAYS, TIMEZONES (+2 more)

### Community 87 - "Face Capture Verification"
Cohesion: 0.35
Nodes (11): CaptureQuality, CaptureState, FaceCapture(), FaceCaptureProps, detectFaceScore(), extractDescriptor(), FaceApiModule, getWebcamStream() (+3 more)

### Community 88 - "Notes Todo Board"
Cohesion: 0.24
Nodes (11): dayKey(), dayLabel(), FILTERS, formatDue(), isOverdue(), PRIORITIES, todayKey(), TodoApp() (+3 more)

### Community 89 - "Pending Approval Requests"
Cohesion: 0.26
Nodes (9): approveRequest(), bulkApproval(), getApprovals(), rejectRequest(), Approval, PendingApprovalsCard, ApprovalRow, ApprovalsTab() (+1 more)

### Community 90 - "Call Signaling State"
Cohesion: 0.21
Nodes (9): getActiveCall(), AnyCallData, CallState, useCallState(), WsSendRef, mockConsumePendingCall, mockGetActiveCall, mockGetIceConfig (+1 more)

### Community 91 - "Email Template Management"
Cohesion: 0.23
Nodes (11): getEmailTemplates(), previewEmailTemplate(), revertEmailTemplate(), updateEmailTemplate(), EmailTemplate, EmailTemplatesSection(), EmailTemplatesSectionProps, EMPTY_TEMPLATES (+3 more)

### Community 92 - "Notes Markdown Conversion"
Cohesion: 0.33
Nodes (11): childrenToMd(), decodeEntities(), escapeHtml(), escapeMd(), htmlToMarkdown(), inlineMd(), listToMd(), markdownToHtml() (+3 more)

### Community 93 - "Package Build Scripts"
Cohesion: 0.18
Nodes (11): scripts, build, dev, generate-emoji, generate-icons, prebuild, predev, preview (+3 more)

### Community 94 - "Desktop Icon Generation"
Cohesion: 0.22
Nodes (9): DESKTOP_MODULES, fs, generate(), path, pngToIco, PUBLIC_DIR, REPO_ROOT, sharp (+1 more)

### Community 95 - "Task Backlog Operations"
Cohesion: 0.29
Nodes (10): addBacklogTask(), assignTaskToSprint(), getBacklog(), scheduleTask(), unscheduleTask(), updateTask(), BacklogSummary, ShowConfirm (+2 more)

### Community 96 - "Member Request Management"
Cohesion: 0.22
Nodes (8): getMemberRequests(), EMPTY, MemberRequestsTab(), MemberRequestsTabProps, RequestRow, LeaveIconForProps, RequestDetails(), RequestDetailsProps

### Community 97 - "Today's Calendar Events"
Cohesion: 0.31
Nodes (10): CalEvent, EventItem(), formatEventTime(), getMinutesUntil(), isHappeningNow(), isJoinable(), isNowOrPast(), isStartingSoon() (+2 more)

### Community 98 - "Web App Manifest"
Cohesion: 0.20
Nodes (9): background_color, description, display, icons, name, orientation, short_name, start_url (+1 more)

### Community 99 - "Employee Salary Slips"
Cohesion: 0.29
Nodes (9): downloadMySalarySlipPdf(), getMyBankDetails(), getMySalarySlips(), saveMyBankDetails(), BankForm, EMPTY_SLIPS, inputStyle, MySalarySlips() (+1 more)

### Community 100 - "Member Hours Overview"
Cohesion: 0.27
Nodes (8): getMemberHours(), getMemberOverview(), EmployeeDashboard(), EmployeeDashboardProps, EMPTY, HourRow, MemberHoursTab(), MemberHoursTabProps

### Community 101 - "Dashboard Tasks and Timeline"
Cohesion: 0.20
Nodes (7): TaskItem, TasksSummary, TaskSummaryData, TIMELINE_ICONS, TIMELINE_LABELS, TimelineCard, TimelineEntry

### Community 102 - "Member Status Overview"
Cohesion: 0.24
Nodes (6): LeaveIconForProps, MemberOverviewProps, PriorityBadge(), PriorityBadgeProps, StatusBadge(), StatusBadgeProps

### Community 103 - "Vite Environment Types"
Cohesion: 0.20
Nodes (9): *.css, ElectronAPI, ImportMeta, ImportMetaEnv, *.jpg, *.module.css, *.png, *.svg (+1 more)

### Community 104 - "Platform User Administration"
Cohesion: 0.36
Nodes (6): createPlatformUser(), deactivatePlatformUser(), resetPlatformUserPassword(), ConfirmDialog(), ConfirmDialogProps, PlatformAdmins()

### Community 105 - "Impersonation Session Banner"
Cohesion: 0.31
Nodes (7): exitImpersonation(), getImpersonationSession(), formatElapsed(), ImpersonationBanner(), SessionAction, SessionInfo, SessionSummaryModalProps

### Community 106 - "Member Leave Approvals"
Cohesion: 0.28
Nodes (7): getMemberLeaves(), ApprovalBadge(), ApprovalBadgeProps, EMPTY, LeaveRow, MemberLeavesTab(), MemberLeavesTabProps

### Community 107 - "Bulk User Import"
Cohesion: 0.28
Nodes (8): importUsers(), downloadCredentialsCSV(), FieldDef, FIELDS, ImportDetail, ImportFailed, ImportResult, ImportUsers()

### Community 108 - "WebRTC Media Connections"
Cohesion: 0.31
Nodes (8): applyPublicTurnPolicy(), buildMediaConstraintProfiles(), FALLBACK_ICE_SERVERS, hasRealTurn(), IMPORTANT: do NOT seed remoteVideoOff from e.track.muted —, REAL_TURN_MODES, useWebRTC(), UseWebRTCParams

### Community 109 - "Message Reactions"
Cohesion: 0.25
Nodes (7): Reaction, ReactionBar(), ReactionBarProps, ReactionMsg, EMOJIS, ReactionPicker(), ReactionPickerProps

### Community 110 - "Notes Editor Context Menu"
Cohesion: 0.31
Nodes (8): CALLOUT_VARIANTS, DetectedTarget, detectTarget(), EditorContextMenu(), EditorContextMenuProps, getTypeIcon(), MenuState, Quill_findBlot()

### Community 111 - "Event Reminder Toasts"
Cohesion: 0.25
Nodes (7): EventReminderToast(), EventReminderToastProps, formatTime(), Reminder, ReminderEvent, ReminderItem(), ReminderItemProps

### Community 112 - "Leave Page Tests"
Cohesion: 0.22
Nodes (7): mockAddLeave, mockAddLeavesBatch, mockExportMyLeaves, mockGetLeaveBalances, mockGetLeavePolicies, mockGetLeaves, mockWithdrawLeave

### Community 113 - "Emoji Sprite Categories"
Cohesion: 0.29
Nodes (8): Emoji Glyph Atlas, Emoji Sprite Sheet, Gestures and Body Parts, National Flags, Objects, Food, and Activities, People and Faces, Skin Tone Variants, Symbols and Interface Icons

### Community 114 - "Package Metadata"
Cohesion: 0.25
Nodes (7): author, description, keywords, license, main, name, version

### Community 115 - "Face Model Assets"
Cohesion: 0.32
Nodes (7): copyOne(), DEST, __dirname, exists(), FILES, main(), SRC

### Community 116 - "Call History Management"
Cohesion: 0.39
Nodes (7): deleteCalls(), getAllCallHistory(), CallEntry, CallsTab(), CallsTabProps, formatCallDuration(), formatCallTime()

### Community 117 - "Manager Request Dashboard"
Cohesion: 0.32
Nodes (4): getMyRequests(), EMPTY, MyRequests(), RequestRow

### Community 118 - "Notes Persistence"
Cohesion: 0.43
Nodes (7): getNotes(), saveNotes(), migratePageModel(), NoteTodo, NotesData, useNotesPersistence(), UseNotesPersistenceResult

### Community 119 - "Sprint Notes Embed"
Cohesion: 0.29
Nodes (6): getSprintEmbed(), SprintEmbedBlock(), SprintEmbedBlockProps, SprintStats, STATUS_COLORS, STATUS_LABELS

### Community 120 - "Tenant Platform Overview"
Cohesion: 0.39
Nodes (5): getTenantAlerts(), getTenantOverview(), alertLabel(), formatValue(), PlatformDashboard()

### Community 121 - "Meeting HLS Broadcast"
Cohesion: 0.32
Nodes (7): startMeetingHlsBroadcast(), stopMeetingHlsBroadcast(), BroadcastState, QueueItem, useHlsBroadcast(), UseHlsBroadcastOptions, UseHlsBroadcastResult

### Community 124 - "MediaPipe Runtime Assets"
Cohesion: 0.38
Nodes (6): DEST, __dirname, exists(), main(), RUNTIME_EXTS, SRC

### Community 125 - "Face Enrollment"
Cohesion: 0.33
Nodes (6): clearFaceEnrollment(), enrollFace(), getFaceStatus(), FaceEnrollment(), FaceStatus, ToastState

### Community 126 - "Conversation Call History"
Cohesion: 0.48
Nodes (6): getCallHistory(), CallHistory(), CallHistoryProps, formatDuration(), formatTime(), getDirectionIcon()

### Community 127 - "Platform Audit Overview"
Cohesion: 0.43
Nodes (6): getPlatformAuditLogs(), getPlatformUsers(), getTenants(), ACTION_COLORS, PlatformAuditLogs(), SEVERITY

### Community 128 - "Calendar Task Page"
Cohesion: 0.38
Nodes (4): getTasks(), CalendarPage(), EMPTY, mockGetTasks

### Community 129 - "Shared Notes Access"
Cohesion: 0.53
Nodes (5): createNoteShare(), getNoteShare(), revokeNoteShare(), ShareNoteModal(), ShareNoteModalProps

### Community 130 - "Custom Fields Context"
Cohesion: 0.47
Nodes (5): getCustomFields(), Ctx, CustomFieldsContextValue, CustomFieldsProvider(), CustomFieldDef

### Community 131 - "Chat Message Search"
Cohesion: 0.40
Nodes (5): searchMessages(), highlightMatch(), MessageSearch(), MessageSearchProps, SearchResult

### Community 132 - "In Call Chat Panel"
Cohesion: 0.40
Nodes (4): CallChatPanel(), CallChatPanelProps, formatFileSize(), SendIcon()

### Community 133 - "Small App Icon"
Cohesion: 0.70
Nodes (5): Cyan Rounded Loop, Green Rounded Loop, Interlocking Loop Motif, WorkPulse App Icon, Yellow Rounded Loop

### Community 134 - "Large App Icon"
Cohesion: 0.60
Nodes (5): Blue Diagonal Rounded Loop, Green Diagonal Rounded Loop, Interlocking Rounded Loop Motif, WorkPulse Application Icon, Yellow Vertical Rounded Loop

### Community 135 - "Payment Provider Settings"
Cohesion: 0.70
Nodes (4): getPaymentConfig(), savePaymentConfig(), testPaymentConfig(), PaymentSettings()

### Community 136 - "Pinned Chat Messages"
Cohesion: 0.50
Nodes (4): getPinnedMessages(), PinnedMessage, PinnedMessages(), PinnedMessagesProps

### Community 137 - "Call Device Widgets"
Cohesion: 0.40
Nodes (4): DeviceSelector(), DeviceSelectorProps, MediaDeviceLike, QualityBadge()

### Community 138 - "Call Controls Hook"
Cohesion: 0.40
Nodes (4): CallOverlay(), DetailedStats, useCallControls(), UseCallControlsParams

### Community 139 - "Polling Interval Constants"
Cohesion: 0.40
Nodes (4): NOTIFICATION_POLL_INTERVAL, QUOTE_ROTATION_INTERVAL, REFRESH_TOKEN_INTERVAL, STATUS_POLL_INTERVAL

### Community 140 - "Application HTML Shell"
Cohesion: 0.50
Nodes (4): AINO, Floor Hours, Breaks, and Attendance Tracking, Progressive Web App Shell, React Application Root

## Knowledge Gaps
- **954 isolated node(s):** `name`, `version`, `description`, `main`, `predev` (+949 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `useAuth()` connect `Application Infrastructure` to `Calendar Task Page`, `Leave and Holiday Management`, `Custom Fields Context`, `Notification and Call Alerts`, `Chat Realtime Collaboration`, `Calendar Event Management`, `Meeting State Management`, `Task Detail Management`, `Navigation and Notifications`, `Profile Search and Mentions`, `Authentication and Biometrics`, `Organization Structure Management`, `Notes Folder Management`, `Notes Export and Templates`, `Admin User Management`, `Meeting Room Interface`, `Branding and App Contexts`, `User Presence Status`, `Notes History and Properties`, `Notes Capture Tools`, `Password and Policy Forms`, `Attendance Timer Dashboard`, `Project Management`, `Live Attendance Tracking`, `Organization Task Labels`, `Organization Role Labels`, `Meeting Connection Preflight`, `Daily Notes Home`, `Common Error Handling`, `Tenant Creation and Plans`, `Dashboard Events and Reminders`, `Authentication Session Context`, `GitHub Repository Integration`, `Service Desk Tickets`, `Agile Configuration Context`, `User Profile Menu`, `Platform User Administration`, `Impersonation Session Banner`?**
  _High betweenness centrality (0.096) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Frontend Runtime Dependencies` to `Profile Search and Mentions`, `PDF Export Dependency`, `Math Rendering Dependency`, `Map Rendering Dependency`, `Package Metadata`, `React Map Integration`, `WebAuthn Browser Dependency`, `Query Storage Persistence`, `React Query Dependency`, `Persistent React Queries`, `Collaborative Editing Dependency`, `Common Error Handling`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Why does `react-dom` connect `Frontend Runtime Dependencies` to `Platform User Administration`, `Authentication and Biometrics`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _954 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Leave and Holiday Management` be split into smaller, more focused modules?**
  _Cohesion score 0.054773082942097026 - nodes in this community are weakly interconnected._
- **Should `Meeting State Management` be split into smaller, more focused modules?**
  _Cohesion score 0.050724637681159424 - nodes in this community are weakly interconnected._
- **Should `Notification and Call Alerts` be split into smaller, more focused modules?**
  _Cohesion score 0.053613053613053616 - nodes in this community are weakly interconnected._