# Graph Report - mobile  (2026-08-04)

## Corpus Check
- 324 files · ~1,140,069 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2878 nodes · 7276 edges · 196 communities (133 shown, 63 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 38 edges (avg confidence: 0.73)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `769fd5bd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- notifeeService.ts
- attendance.tsx
- TopBar.tsx
- features.ts
- admin.ts
- emojiStore.ts
- [conversationId].tsx
- organization.tsx
- app/index.tsx
- NotificationLoggerService
- DatePicker.tsx
- useAuth
- IncomingCallListener.tsx
- useChatThread.ts
- scripts
- tasks/[id].tsx
- icons/index.tsx
- team.tsx
- [code].tsx
- SharedMediaGallery.tsx
- tasks.tsx
- LeavesTab.tsx
- org-settings.tsx
- add-people.tsx
- compensation.tsx
- chat/index.ts
- org-chart.tsx
- useTheme
- PushNotificationListener.tsx
- app/_layout.tsx
- profile.tsx
- tenants/[id].tsx
- CallRingService
- user/[id].tsx
- salary-slips.tsx
- chat/[id].tsx
- (tabs)/index.tsx
- theme.ts
- Theme
- ChatAvatar.tsx
- saved.tsx
- calendar.tsx
- AuthContext.tsx
- backgroundPushService.ts
- admins.tsx
- chatCache.ts
- FilePreview.tsx
- insights.tsx
- mediaCache.ts
- notesUtils.ts
- list.tsx
- nativeCallService.ts
- updater.ts
- chat.tsx
- useNotesStore.ts
- notificationPayloadValidator.ts
- notes/[id].tsx
- chatOutbox.ts
- useDialog
- tenants/index.tsx
- dependencies
- tsconfig.jest.json
- CallControls.tsx
- RecentMediaStrip.tsx
- RealtimeSocket
- notificationDeduplicator.ts
- create.tsx
- gen-custom-icons.cjs
- ClockInVerifyModal.tsx
- ServiceDeskTab.tsx
- [userId].tsx
- settings.tsx
- Expo SDK 57 Migration — Feasibility, Risks & Plan
- ActiveCallService
- tsconfig.json
- uploadUrl
- leaves.tsx
- Mobile Chat Performance and Media Verification
- CallVideoPrimitives.tsx
- ClockOutVerifyModal.tsx
- WorkTimerCard.tsx
- templates.ts
- ChatUnreadEvents
- nativeCallService.test.ts
- mediaDimensionsCache.ts
- app/search.tsx
- AvatarLoader
- PipModule
- generate-call-sounds.cjs
- moduleBoundaries.test.ts
- InlineVideo.tsx
- NativeSelectField.tsx
- leaves.ts
- admin/audit.tsx
- integrations.tsx
- VerifyError.tsx
- PushNotificationListener
- projects.tsx
- ConversationNotificationsModule
- withAndroidSigning.js
- api.ts
- admin/index.tsx
- CallActionActivity
- MMKV
- LockScreenModule
- tokenStore.ts
- CallScreenOverlay.tsx
- Composer.tsx
- NativeSwitch.tsx
- mmkv.ts
- PendingCallActionStore
- `react-native-webrtc+124.0.7.patch` — true rounded corners for the self-view
- AINO Mobile Release Guide (GitHub Actions + Cloudflare R2)
- generate-icons.cjs
- useMobileConversationDraft.ts
- MonthPicker.tsx
- MediaEditor.tsx
- PendingRequestsList.tsx
- more.tsx
- Picture-in-Picture (PiP) — call window minimize
- withAndroidPip.js
- ChatTabSwitcher.tsx
- expo-video
- CallRingerModule
- withAndroidNotificationIcon.js
- withAndroidRingtoneAssets.js
- withRemoveExpoFirebaseMessagingService.js
- LeaveRequestForm
- chat.ts
- metro.config.js
- withAndroidGradleMemory.js
- withFirebaseNotificationChannelOverride.js
- AGENTS.md
- @config-plugins/react-native-webrtc
- expo
- expo-build-properties
- expo-camera
- expo-clipboard
- expo-constants
- expo-document-picker
- expo-file-system
- expo-font
- @expo-google-fonts/inter
- @expo-google-fonts/pacifico
- expo-image
- expo-image-manipulator
- expo-image-picker
- expo-intent-launcher
- expo-keep-awake
- expo-linear-gradient
- expo-linking
- expo-local-authentication
- expo-location
- expo-notifications
- expo-router
- expo-secure-store
- expo-splash-screen
- expo-status-bar
- @expo/ui
- expo-video-thumbnails
- @notifee/react-native
- react
- react-dom
- react-native
- react-native-callkeep
- @react-native-firebase/app
- @react-native-firebase/messaging
- react-native-gesture-handler
- react-native-incall-manager
- @react-native/metro-config
- react-native-mmkv
- react-native-nitro-modules
- react-native-reanimated
- react-native-safe-area-context
- react-native-svg
- react-native-view-shot
- react-native-web
- react-native-webrtc
- react-native-webview
- react-native-wheel-color-picker
- react-native-worklets
- @shopify/flash-list
- @tanstack/query-core
- @tanstack/react-query-persist-client
- zustand
- withAndroidCallActivityFlags.js
- withAndroidNewIntent.js

## God Nodes (most connected - your core abstractions)
1. `useTheme()` - 323 edges
2. `Theme` - 140 edges
3. `useAuth()` - 90 edges
4. `uploadUrl()` - 55 edges
5. `useChatThread()` - 51 edges
6. `getToken()` - 35 edges
7. `NotifeeService` - 33 edges
8. `useKeyboardInset()` - 32 edges
9. `CallScreen()` - 31 edges
10. `useDialog()` - 29 edges

## Surprising Connections (you probably didn't know these)
- `NotesLayout()` --calls--> `useTheme()`  [EXTRACTED]
  mobile/app/notes/_layout.tsx → mobile/src/theme/ThemeProvider.tsx
- `useChatThread()` --indirect_call--> `applyMessageDelete()`  [INFERRED]
  mobile/src/components/chat/useChatThread.ts → mobile/src/components/chat/chatMessageReducers.ts
- `useMeetingMesh()` --indirect_call--> `key()`  [INFERRED]
  mobile/src/meeting/useMeetingMesh.ts → mobile/src/storage/chatLocalDeletes.ts
- `markCallCancelled()` --indirect_call--> `key()`  [INFERRED]
  mobile/src/services/notifeeService.ts → mobile/src/storage/chatLocalDeletes.ts
- `clearAllChatCache()` --indirect_call--> `key()`  [INFERRED]
  mobile/src/storage/chatCache.ts → mobile/src/storage/chatLocalDeletes.ts

## Import Cycles
- None detected.

## Communities (196 total, 63 thin omitted)

### Community 0 - "notifeeService.ts"
Cohesion: 0.07
Nodes (45): stopRinging(), ConversationNotificationMetadata, ConversationNotifications, ConversationNotificationsNativeModule, ensureAndroidConversation(), EnsureConversationOptions, isConversationNotificationsAvailable, sendMessage() (+37 more)

### Community 1 - "attendance.tsx"
Cohesion: 0.06
Nodes (61): AnalyticsTab(), AttendanceScreen(), BreakItem, buildMonthGrid(), DayKind, DetailRow(), EMPTY_ANALYTICS, EMPTY_ENTRIES (+53 more)

### Community 2 - "TopBar.tsx"
Cohesion: 0.05
Nodes (30): EMPTY_NOTIFICATIONS, makeStyles(), NotificationsData, NotificationsScreen(), timeAgo(), TabBarButtonProps, TabsLayout(), metaForStatus() (+22 more)

### Community 3 - "features.ts"
Cohesion: 0.04
Nodes (43): GroupSettings(), makeStyles(), FoundUser, initials(), makeStyles(), NewChatScreen(), ActiveCall, AgileConfig (+35 more)

### Community 4 - "admin.ts"
Cohesion: 0.06
Nodes (51): AgileConfigData, AgileConfigScreen(), COLOR_PRESETS, EMPTY_FIELDS, EMPTY_LABELS, EMPTY_STATES, EMPTY_TYPES, ESTIMATION_PRESETS (+43 more)

### Community 5 - "emojiStore.ts"
Cohesion: 0.10
Nodes (41): EmojiKeyboard(), makeStyles(), EmojiPicker(), makeStyles(), buildEmojiSections(), chunk(), currentRecents(), EmojiRow (+33 more)

### Community 6 - "[conversationId].tsx"
Cohesion: 0.07
Nodes (41): CallScreen(), IMPORTANT: socket.send() silently returns false when the WS isn't open, makeStyles(), CallRinger, isCallRingerAvailable, PendingCallAction, startActiveCall(), StartActiveCallOptions (+33 more)

### Community 7 - "organization.tsx"
Cohesion: 0.07
Nodes (44): AdminHomeScreen(), DEFAULT_SETUP, makeStyles(), QuickBtn(), SetupState, StatTile(), ADMIN_ROLES, ALL_TABS (+36 more)

### Community 8 - "app/index.tsx"
Cohesion: 0.12
Nodes (37): Index(), clearPendingCallAction(), getPendingCallAction(), meetingHrefForGroupCall(), clearPersistedPendingCall(), consumePendingCall(), loadPersistedPendingCall(), peekPendingCall() (+29 more)

### Community 9 - "NotificationLoggerService"
Cohesion: 0.09
Nodes (3): NotificationTestHarness, initializeNotificationLogger(), NotificationLoggerService

### Community 10 - "DatePicker.tsx"
Cohesion: 0.07
Nodes (38): ApplyLeaveScreen(), DURATIONS, makeStyles(), todayISO(), TYPES, DatePicker(), buildMonthGrid(), DatePicker() (+30 more)

### Community 11 - "useAuth"
Cohesion: 0.09
Nodes (33): GroupCallRingScreen(), makeStyles(), resolveAvatarUrl(), useAuth(), getNotificationPrefs(), NotificationPrefs, warmIceConfig(), makeStyles() (+25 more)

### Community 12 - "IncomingCallListener.tsx"
Cohesion: 0.11
Nodes (34): GROUP_RING_PATHNAME, groupRingParams(), active, ActiveClaim, CallSurface, claim(), ClaimToken, EndListener (+26 more)

### Community 13 - "useChatThread.ts"
Cohesion: 0.08
Nodes (40): normalizeUploadedMessage(), replaceUploadedMessage(), updateMessageById(), isSameDay(), IdentifiedMessage, useChatMessageSelection(), UseChatMessageSelectionResult, appendsNewerServerTail() (+32 more)

### Community 14 - "scripts"
Cohesion: 0.05
Nodes (39): NOTE: Do NOT set `icon`/`color` here. Those options inject, versionParts, babel-preset-expo, eventemitter3, jest, jest-expo, devDependencies, babel-preset-expo (+31 more)

### Community 15 - "tasks/[id].tsx"
Cohesion: 0.09
Nodes (36): formatPoints(), isImageAttachment(), openAttachment(), PRIORITIES, STATUSES, makeStyles(), TaskDetail(), timeAgo() (+28 more)

### Community 16 - "icons/index.tsx"
Cohesion: 0.10
Nodes (37): Activity, AlarmClock, CalendarOff, CalendarPlus, CalendarRange, CalendarX, CheckCheck, CheckSquare (+29 more)

### Community 17 - "team.tsx"
Cohesion: 0.10
Nodes (34): AnalyticsTab(), APPROVAL_FILTERS, ApprovalsTab(), AttendanceTab(), EMPTY_APPROVALS, EMPTY_MEMBERS, initials(), MemberRow() (+26 more)

### Community 18 - "[code].tsx"
Cohesion: 0.11
Nodes (29): ControlButton(), formatTime(), LobbyScreen(), MeetingScreen(), ParticipantRow(), resolveAvatarUrl(), makeStyles(), VideoTile() (+21 more)

### Community 19 - "SharedMediaGallery.tsx"
Cohesion: 0.11
Nodes (29): extractFirstUrl(), hasUrl(), downloadAuthedToCache(), exportAuthedFile(), getMediaLibrary(), Result, saveAuthedFileToLibrary(), shareAuthedFile() (+21 more)

### Community 20 - "tasks.tsx"
Cohesion: 0.09
Nodes (32): EMPTY_SPRINTS, EMPTY_TASKS, PRIORITY_FILTERS, SPRINT_MANAGER_ROLES, sprintDaysLeft(), STATUS_FILTERS, Tab, TabButton() (+24 more)

### Community 21 - "LeavesTab.tsx"
Cohesion: 0.10
Nodes (33): ACCRUAL_OPTIONS, AllBalancesTab(), BalancesTab(), BASE_TABS, DURATIONS, EMPTY_ALL_BALANCES, EMPTY_BALANCES, EMPTY_LEAVES (+25 more)

### Community 22 - "org-settings.tsx"
Cohesion: 0.08
Nodes (30): ACCENT_PRESETS, buildMapHtml(), EMPTY_ROLES, EMPTY_TEMPLATES, OrgSettingsScreen(), parseWorkDays(), PERMISSION_LEVELS, ROLE_COLORS (+22 more)

### Community 23 - "add-people.tsx"
Cohesion: 0.08
Nodes (30): AddPeopleScreen(), EMPTY_OPTIONS, makeStyles(), Method, METHODS, ParsedRow, ParseError, parsePaste() (+22 more)

### Community 24 - "compensation.tsx"
Cohesion: 0.08
Nodes (30): CompensationScreen(), Component, CTC_DEFAULTS, DEFAULT_COMPONENTS, EMPTY_BANK, EMPTY_EMPLOYEES, EMPTY_MEMBERS, EMPTY_TEMPLATES (+22 more)

### Community 25 - "chat/index.ts"
Cohesion: 0.11
Nodes (25): emojiOnlyCount(), fmtTime(), isEmojiOnlyMessage(), areEqual(), makeStyles(), MessageBubble, MessageBubbleImpl(), MessageBubbleProps (+17 more)

### Community 26 - "org-chart.tsx"
Cohesion: 0.10
Nodes (29): DeptCard(), EMPTY_DEPARTMENTS, EMPTY_MEMBERS, EMPTY_TEAMS, initials(), makeStyles(), MemberChip(), OrgChartScreen() (+21 more)

### Community 27 - "useTheme"
Cohesion: 0.10
Nodes (25): ThemedStack(), LoginScreen(), makeStyles(), ModalShell(), StatusDot(), StatusPickerModal(), makeStyles(), ThemePickerModal() (+17 more)

### Community 28 - "PushNotificationListener.tsx"
Cohesion: 0.12
Nodes (11): persistPendingChat(), setPendingChat(), buildPendingChatRouteFromMessageNotification(), checkAndRecoverPermissions(), handleCallNotification(), handleGeneralNotification(), handleMessageNotification(), handlePushNotification() (+3 more)

### Community 29 - "app/_layout.tsx"
Cohesion: 0.10
Nodes (20): applyDefaultFont(), queryClient, NOTE: freezeOnBlur was REMOVED here. The thread now uses a, IMPORTANT: The foreground FCM message handler is now registered at the, RootLayout(), ThemedStatusBar(), NOTE: use require (not a static import) so this runs AFTER the top-level, installThemedAlertBridge() (+12 more)

### Community 30 - "profile.tsx"
Cohesion: 0.08
Nodes (27): ChangePasswordModal(), EditProfileModal(), initials(), MENTION_TONES, MESSAGE_TONES, NotificationSoundsModal(), OUTGOING_TONES, PICKABLE (+19 more)

### Community 31 - "tenants/[id].tsx"
Cohesion: 0.10
Nodes (28): AccessStep, ConfirmAction, InfoCard(), RequestAccessModal(), Stat(), statusColor(), makeMaStyles(), makeStyles() (+20 more)

### Community 32 - "CallRingService"
Cohesion: 0.14
Nodes (12): MediaPlayer, CallRingService, Bitmap, Context, IBinder, Intent, Service, start() (+4 more)

### Community 33 - "user/[id].tsx"
Cohesion: 0.10
Nodes (25): makeStyles(), PaymentSettingsScreen(), TRANSFER_MODES, AdminUserDetail(), EMPTY_OPTIONS, initials(), makeStyles(), adminResetPassword() (+17 more)

### Community 34 - "salary-slips.tsx"
Cohesion: 0.10
Nodes (26): EMPTY_PERIODS, fmtDate(), makeStyles(), monthRange(), PayrollScreen(), EMPTY_DISBURSEMENTS, EMPTY_PERIODS, EMPTY_SLIPS (+18 more)

### Community 35 - "chat/[id].tsx"
Cohesion: 0.09
Nodes (22): AttachmentPicker, CameraCapture, ConversationBody(), DeleteOptionsSheet, EmojiPicker, HeaderMenuPopup, makeStyles(), MediaEditor (+14 more)

### Community 36 - "(tabs)/index.tsx"
Cohesion: 0.12
Nodes (25): Dashboard(), DASHBOARD_QUERY_KEY, DashboardData, dayBounds(), fetchDashboard(), getGreeting(), makeStyles(), ROLE_LEVELS (+17 more)

### Community 37 - "theme.ts"
Cohesion: 0.14
Nodes (22): getBranding(), HeaderMenuPopup(), makeStyles(), ColorPicker(), ColorPickerProps, DEFAULT_PRESETS, makeStyles(), useSettings (+14 more)

### Community 38 - "Theme"
Cohesion: 0.10
Nodes (23): HeaderSheet, DeleteOptionsSheet(), makeStyles(), HeaderMenuSheet(), makeStyles(), makeStyles(), MessageActionsSheet(), makeStyles() (+15 more)

### Community 39 - "ChatAvatar.tsx"
Cohesion: 0.11
Nodes (19): CallInfoScreen(), makeStyles(), ChatInfo(), makeStyles(), WORK_MODE_COLOR, STATUS_LABEL, WORK_MODE_LABEL, makeStyles() (+11 more)

### Community 40 - "saved.tsx"
Cohesion: 0.13
Nodes (22): ChatSaved(), makeStyles(), Mode, Row, ChatSearch(), makeStyles(), fmtDateTime(), makeStyles() (+14 more)

### Community 41 - "calendar.tsx"
Cohesion: 0.14
Nodes (24): buildMonthGrid(), CalendarScreen(), EMPTY_EVENTS, EVENT_COLORS, eventLocalDay(), EventModal(), fetchCalendarEvents(), fmtEventTime() (+16 more)

### Community 42 - "AuthContext.tsx"
Cohesion: 0.16
Nodes (23): AuthContext, AuthContextValue, AuthProvider(), User, BiometricCapability, BiometricKind, biometricPlatform, clearBiometricCredential() (+15 more)

### Community 43 - "backgroundPushService.ts"
Cohesion: 0.13
Nodes (9): isConversationActive(), BackgroundPushService, NOTE: this flag is intentionally NOT used to gate the incoming-call surface, IMPORTANT: This MUST run at the JS entry top-level (see `mobile/index.js`),, IMPORTANT: This can be called either:, RemoteMessage, buildNotificationPayload(), normalizeNotificationData() (+1 more)

### Community 44 - "admins.tsx"
Cohesion: 0.11
Nodes (22): EMPTY_REQUESTS, fmt(), makeStyles(), PlatformAccessScreen(), RevealedCode, statusPalette(), makeStyles(), PlatformAdminsScreen() (+14 more)

### Community 45 - "chatCache.ts"
Cohesion: 0.21
Nodes (21): applyMediaJobUpdate(), applyMessageDelete(), applyMessageEdit(), applyMessagePin(), applyMessageReaction(), mapRealtimeChatMessage(), RealtimeData, ChatCacheSync() (+13 more)

### Community 46 - "FilePreview.tsx"
Cohesion: 0.15
Nodes (18): ChatList(), ALL_EMOJIS, EMOJIS, fmtDaySeparator(), fmtSize(), isAudioFile(), isImageFile(), isVideoFile() (+10 more)

### Community 47 - "insights.tsx"
Cohesion: 0.14
Nodes (21): EMPTY_SPRINTS, EMPTY_TASKS, fmtDays(), makeStyles(), SprintInsights(), StatCard(), STATUS_LABEL, userHasFeature() (+13 more)

### Community 48 - "mediaCache.ts"
Cohesion: 0.17
Nodes (20): AuthedImage(), AuthedImageProps, RESIZE_MODE_TO_CONTENT_FIT, clearMediaCache(), ensureCachedMedia(), ensureDir(), extFromUrl(), getCachedMedia() (+12 more)

### Community 49 - "notesUtils.ts"
Cohesion: 0.16
Nodes (17): getGreeting(), makeStyles(), NotesHomeScreen(), todayLong(), buildFolderTree(), decodeEntities(), extractHeadings(), extractPageLinks() (+9 more)

### Community 50 - "list.tsx"
Cohesion: 0.14
Nodes (20): actionColor(), ENTITY_TYPES, ExtendedLog, fmtTime(), KNOWN_ACTIONS, makeStyles(), parseDetails(), PlatformAuditScreen() (+12 more)

### Community 51 - "nativeCallService.ts"
Cohesion: 0.17
Nodes (9): emitAnswerIntent(), rejectCallHttp(), ActionHandler, CALLKEEP_EVENTS, CallKeepEvent, CallKeepModule, NativeAction, NativeCallService (+1 more)

### Community 52 - "updater.ts"
Cohesion: 0.17
Nodes (18): makeStyles(), triggerUpdateCheck(), UpdateChecker(), mockDownloadAsync, mockStartActivityAsync, checkForMobileUpdate(), checkGithub(), checkR2() (+10 more)

### Community 53 - "chat.tsx"
Cohesion: 0.14
Nodes (19): callDuration(), ChatScreen(), convName(), ListRow, makeStyles(), MUTE_OPTIONS, NOTE: the initial conversation-list fetch is handled by the `useFocusEffect`, SearchUser (+11 more)

### Community 54 - "useNotesStore.ts"
Cohesion: 0.18
Nodes (19): convertNoteToTask(), getDailyPrefill(), getNotes(), getOneOnOnePrefill(), Notebook, NoteFolder, NotePage, NoteTodo (+11 more)

### Community 55 - "notificationPayloadValidator.ts"
Cohesion: 0.13
Nodes (10): ALERT_REQUIRED_FIELDS, CALL_OPTIONAL_FIELDS, CALL_REQUIRED_FIELDS, MESSAGE_OPTIONAL_FIELDS, MESSAGE_REQUIRED_FIELDS, notificationPayloadValidator, NotificationRoute, ValidationError (+2 more)

### Community 56 - "notes/[id].tsx"
Cohesion: 0.19
Nodes (13): makeStyles(), NoteEditorScreen(), NotesLayout(), makeStyles(), NotesTodoScreen(), PRIORITY_COLORS, PRIORITY_CYCLE, createNoteShare() (+5 more)

### Community 57 - "chatOutbox.ts"
Cohesion: 0.28
Nodes (16): ChatOutboxSync(), flushChatOutbox(), sendOutboxEntry(), clearAllOutboxMessages(), enqueueOutboxMessage(), getAllOutboxMessages(), getOutboxMessage(), getOutboxMessagesForConversation() (+8 more)

### Community 58 - "useDialog"
Cohesion: 0.16
Nodes (14): FaceEnrollment(), makeStyles(), AlertButton, AlertHandler, AlertRequest, registerHandler(), ThemedAlertHost(), clearFaceEnrollment() (+6 more)

### Community 59 - "tenants/index.tsx"
Cohesion: 0.19
Nodes (15): alertColor(), alertLabel(), makeStyles(), PlatformDashboardScreen(), StatTile(), GROUP_ORDER, makeStyles(), PlatformConsole() (+7 more)

### Community 60 - "dependencies"
Cohesion: 0.12
Nodes (17): axios, expo-audio, expo-media-library, expo-sharing, dependencies, axios, expo-audio, expo-media-library (+9 more)

### Community 61 - "tsconfig.jest.json"
Cohesion: 0.12
Nodes (16): android, .expo, ios, jest, jest.setup.js, node, node_modules, **/__tests__/**/*.ts (+8 more)

### Community 62 - "CallControls.tsx"
Cohesion: 0.21
Nodes (14): CallControls(), CallControlsProps, makeStyles(), styles, clamp(), getWindow(), isLargeDevice(), isSmallDevice() (+6 more)

### Community 63 - "RecentMediaStrip.tsx"
Cohesion: 0.20
Nodes (14): AttachmentPicker(), makeStyles(), CameraCapture(), formatSecs(), makeStyles(), Access, formatDuration(), getMediaLibrary() (+6 more)

### Community 65 - "notificationDeduplicator.ts"
Cohesion: 0.18
Nodes (6): checkNotificationDeduplication(), DeduplicationResult, notificationDeduplicator, NotificationDeduplicatorService, NotificationMessage, shouldDisplayNotification()

### Community 66 - "create.tsx"
Cohesion: 0.16
Nodes (13): CreateTenantScreen(), makeStyles(), STEPS, makeStyles(), PlansScreen(), createTenant(), createTenantUser(), getPlanCatalog() (+5 more)

### Community 67 - "gen-custom-icons.cjs"
Cohesion: 0.12
Nodes (13): barrel, distDir, fs, icons, IMPORT_NAME, missing, nameToFile, outFile (+5 more)

### Community 68 - "ClockInVerifyModal.tsx"
Cohesion: 0.17
Nodes (12): ClockInVerifyModal(), makeStyles(), OfficeGeofence, Props, StepPill(), WorkMode, ClockInPayload, getOfficeSignals() (+4 more)

### Community 69 - "ServiceDeskTab.tsx"
Cohesion: 0.20
Nodes (15): getPriority(), getStatus(), getType(), makeStyles(), NewTicketModal(), PRIORITIES, ServiceDeskTab(), STATUSES (+7 more)

### Community 70 - "[userId].tsx"
Cohesion: 0.23
Nodes (14): formatLeaveDate(), initials(), makeStyles(), MemberDetailScreen(), PerfItem(), QuickStat(), requestDetail(), ROLE_LABELS (+6 more)

### Community 71 - "settings.tsx"
Cohesion: 0.16
Nodes (14): ANNOUNCEMENT_DURATIONS, ANNOUNCEMENT_TYPES, Config, makeStyles(), PlatformSettingsScreen(), createAnnouncement(), deleteAnnouncement(), getAdminAnnouncements() (+6 more)

### Community 72 - "Expo SDK 57 Migration — Feasibility, Risks & Plan"
Cohesion: 0.13
Nodes (14): ~30 `expo-*` packages, Compatibility Matrix (SDK 57), Current Baseline (SDK 56), Expo SDK 57 Migration — Feasibility, Risks & Plan, ℹ️ Note (unchanged by this migration), 🟢 Low, 🟡 Medium — our custom native surface (the real focus), ✅ Migration Status: EXECUTED (SDK 56 → 57) (+6 more)

### Community 73 - "ActiveCallService"
Cohesion: 0.24
Nodes (7): ActiveCallService, Context, IBinder, Intent, Service, start(), stop()

### Community 74 - "tsconfig.json"
Cohesion: 0.13
Nodes (14): ./node_modules/expo/tsconfig.base.json, **/*.test.ts, **/*.test.tsx, **/__tests__/**, **/*.ts, **/*.tsx, compilerOptions, jsx (+6 more)

### Community 75 - "uploadUrl"
Cohesion: 0.20
Nodes (11): getToken(), exportMyAnalytics(), openAuthedFile(), openLocalUri(), ANDROID_NATIVE_CALL_UI, API_BASE_URL, Extra, TENOR_API_KEY (+3 more)

### Community 76 - "leaves.tsx"
Cohesion: 0.22
Nodes (13): EMPTY_BALANCES, EMPTY_LEAVES, fetchLeaves(), fmtDate(), LEAVES_QUERY_KEY, LeavesScreen(), makeStyles(), leaveStatusMeta() (+5 more)

### Community 77 - "Mobile Chat Performance and Media Verification"
Cohesion: 0.14
Nodes (13): Automated gates, Chat opening, Cold cache, Forwarded media, Fullscreen image viewer, Fullscreen video viewer, Legacy media, Media dimensions (+5 more)

### Community 78 - "CallVideoPrimitives.tsx"
Cohesion: 0.20
Nodes (11): CallMediaStage(), CallStatus, Props, CallDuration, DraggablePipSelfView, FullScreenSelfView, PipSelfView, pipStyles (+3 more)

### Community 79 - "ClockOutVerifyModal.tsx"
Cohesion: 0.20
Nodes (10): ClockOutVerifyModal(), makeStyles(), OfficeGeofence, Props, StepPill(), buildHtml(), FaceCaptureWebView(), makeStyles() (+2 more)

### Community 80 - "WorkTimerCard.tsx"
Cohesion: 0.32
Nodes (12): makeStyles(), stateColor(), WorkTimerCard(), getCurrentOrg(), breakEnd(), breakStart(), clockIn(), clockOut() (+4 more)

### Community 81 - "templates.ts"
Cohesion: 0.23
Nodes (11): DailyPrefill, OneOnOnePrefill, LucideIcon, buildJournalPrefillHtml(), buildOneOnOnePrefillHtml(), escHtml(), getTemplate(), NoteTemplate (+3 more)

### Community 82 - "ChatUnreadEvents"
Cohesion: 0.19
Nodes (4): ChatUnreadEvents, EventEmitterMock, EventListener, UnreadSyncState

### Community 83 - "nativeCallService.test.ts"
Cohesion: 0.15
Nodes (10): mockBeginCallNavigation, mockCallKeep, mockEmitAnswerIntent, mockIsCallActive, mockPendingCallFromData, mockRejectCallHttp, mockSetPendingCall, mockSocket (+2 more)

### Community 84 - "mediaDimensionsCache.ts"
Cohesion: 0.32
Nodes (11): canonicalMediaUri(), dimensionIndexKey(), getCachedMediaDimensions(), hashKey(), MediaDimensions, readDimensionIndex(), setCachedMediaDimensions(), storageKey() (+3 more)

### Community 85 - "app/search.tsx"
Cohesion: 0.21
Nodes (11): buildItems(), GlobalSearchScreen(), makeStyles(), PRIORITY_COLORS, ResultItem, STATUS_LABELS, globalSearch(), GlobalSearchNote (+3 more)

### Community 86 - "AvatarLoader"
Cohesion: 0.33
Nodes (3): AvatarLoader, Bitmap, Context

### Community 87 - "PipModule"
Cohesion: 0.23
Nodes (6): Context, Module, PipModule, safeRatio(), PictureInPictureParams, Rational

### Community 88 - "generate-call-sounds.cjs"
Cohesion: 0.31
Nodes (10): buildRingback(), buildRingtoneFromNotes(), encodeWavPcm16(), fs, main(), path, renderNotes(), RINGBACK_NOTES (+2 more)

### Community 89 - "moduleBoundaries.test.ts"
Cohesion: 0.24
Nodes (10): CALLS_ROOT, fs, GROUP, importSpecifiers(), listSourceFiles(), P2P, path, resolveTarget() (+2 more)

### Community 90 - "InlineVideo.tsx"
Cohesion: 0.24
Nodes (10): fmtDuration(), fsStyles, InlineVideo(), posterCache, PosterEntry, posterGet(), posterSet(), styles (+2 more)

### Community 91 - "NativeSelectField.tsx"
Cohesion: 0.20
Nodes (10): ExpoUiPickerComponent, ExpoUiPickerProps, makeStyles(), NativeSelect, nativeSelectAvailable, NativeSelectField(), NativeSelectFieldProps, NativeSelectModule (+2 more)

### Community 92 - "leaves.ts"
Cohesion: 0.24
Nodes (10): buildLeaveTypeMeta(), buildLeaveTypeOptions(), hexToBg(), LEAVE_TYPE_MAP, LEAVE_TYPES, LeavePolicyLike, LeaveTypeMeta, prettify() (+2 more)

### Community 93 - "admin/audit.tsx"
Cohesion: 0.31
Nodes (9): actionColor(), AuditLogsScreen(), EMPTY_LOGS, fmtTime(), makeStyles(), RANGES, rangeToDates(), AuditLog (+1 more)

### Community 94 - "integrations.tsx"
Cohesion: 0.27
Nodes (9): EMPTY_INTEGRATIONS, IntegrationsScreen(), makeStyles(), deleteIntegration(), disconnectGithub(), getGithubStatus(), getIntegrations(), GithubStatus (+1 more)

### Community 95 - "VerifyError.tsx"
Cohesion: 0.31
Nodes (8): fmt(), makeStyles(), Props, VerifyError(), clockInErrorInfo, ClockInErrorKind, FACE_CODES, LOCATION_CODES

### Community 96 - "PushNotificationListener"
Cohesion: 0.20
Nodes (3): NotificationPayload, NotificationResponse, PushNotificationListener

### Community 97 - "projects.tsx"
Cohesion: 0.28
Nodes (8): EMPTY_PROJECTS, makeStyles(), ProjectsScreen(), archiveProject(), createProject(), deleteProject(), getProjects(), Project

### Community 98 - "ConversationNotificationsModule"
Cohesion: 0.31
Nodes (4): IconCompat, ConversationNotificationsModule, Context, Module

### Community 99 - "withAndroidSigning.js"
Cohesion: 0.28
Nodes (6): addReleaseSigningConfig(), findSigningConfigsBody(), fs, groovyEscape(), path, { withAppBuildGradle }

### Community 100 - "api.ts"
Cohesion: 0.28
Nodes (7): api, ApiEnvelope, setUnauthorizedHandler(), makeStyles(), TenorItem, TenorKind, TenorMediaPicker()

### Community 101 - "admin/index.tsx"
Cohesion: 0.32
Nodes (7): AdminPanel(), DEFAULT_BADGES, GROUP_ORDER, isAllowed(), makeStyles(), Section, SECTIONS

### Community 102 - "CallActionActivity"
Cohesion: 0.39
Nodes (3): Bundle, CallActionActivity, Intent

### Community 104 - "LockScreenModule"
Cohesion: 0.36
Nodes (4): Context, Module, LockScreenModule, PowerManager

### Community 105 - "tokenStore.ts"
Cohesion: 0.54
Nodes (6): exitImpersonateTenant(), clearOrigToken(), getOrigToken(), setToken(), ImpersonationBanner(), makeStyles()

### Community 106 - "CallScreenOverlay.tsx"
Cohesion: 0.25
Nodes (7): CallMessage, CallScreenOverlay(), CallStatus, FloatingReaction, Props, MicOff, SwitchCamera

### Community 107 - "Composer.tsx"
Cohesion: 0.36
Nodes (5): fmtRecTime(), Composer, makeStyles(), VoiceRecorderBar(), scrollFocusedIntoView()

### Community 108 - "NativeSwitch.tsx"
Cohesion: 0.25
Nodes (7): ExpoUiHostProps, ExpoUiSwitchProps, NativeMod, NativeSwitch(), nativeSwitchAvailable, NativeSwitchModule, NativeSwitchProps

### Community 109 - "mmkv.ts"
Cohesion: 0.32
Nodes (5): mmkvStorage, storage, mmkvQueryPersister, SettingsState, ThemePreference

### Community 111 - "`react-native-webrtc+124.0.7.patch` — true rounded corners for the self-view"
Cohesion: 0.29
Nodes (6): Applying / verifying, JS usage, patches/, `react-native-webrtc+124.0.7.patch` — true rounded corners for the self-view, What the patch adds (purely additive — nothing existing is changed), Why

### Community 112 - "AINO Mobile Release Guide (GitHub Actions + Cloudflare R2)"
Cohesion: 0.29
Nodes (6): AINO Mobile Release Guide (GitHub Actions + Cloudflare R2), Firebase and signing, Future Google Play distribution, In-app updater, Release a new Android version, Version codes

### Community 113 - "generate-icons.cjs"
Cohesion: 0.29
Nodes (5): ASSETS_DIR, fs, path, REPO_ROOT, SOURCE_PATH

### Community 114 - "useMobileConversationDraft.ts"
Cohesion: 0.33
Nodes (6): buildMobileDraftStorageKey(), ConversationDraft, DraftUser, PendingMediaSource, useMobileConversationDraft(), UseMobileConversationDraftOptions

### Community 115 - "MonthPicker.tsx"
Cohesion: 0.38
Nodes (6): makeStyles(), MonthPicker(), MonthPickerProps, MONTHS_LONG, MONTHS_SHORT, parseYM()

### Community 116 - "MediaEditor.tsx"
Cohesion: 0.40
Nodes (5): EditItem, makeStyles(), MediaEditor(), MediaEditorResult, PEN_COLORS

### Community 117 - "PendingRequestsList.tsx"
Cohesion: 0.47
Nodes (5): fmtDate(), makeStyles(), PendingRequestsList(), RequestRow, STATUS_BADGE

### Community 118 - "more.tsx"
Cohesion: 0.50
Nodes (4): Item, makeStyles(), MoreScreen(), ROLE_LEVELS

### Community 119 - "Picture-in-Picture (PiP) — call window minimize"
Cohesion: 0.40
Nodes (4): Build requirement, How it works (Signal-Android parity), iOS, Picture-in-Picture (PiP) — call window minimize

### Community 121 - "ChatTabSwitcher.tsx"
Cohesion: 0.50
Nodes (4): ChatListTab, ChatTabSwitcher(), makeStyles(), TabMeta

### Community 123 - "expo-video"
Cohesion: 0.50
Nodes (4): expo-video, expo-video, FullscreenVideoPlayer(), VideoStage()

### Community 125 - "withAndroidNotificationIcon.js"
Cohesion: 0.50
Nodes (3): fs, path, { withDangerousMod }

### Community 126 - "withAndroidRingtoneAssets.js"
Cohesion: 0.50
Nodes (3): fs, path, { withDangerousMod }

### Community 127 - "withRemoveExpoFirebaseMessagingService.js"
Cohesion: 0.50
Nodes (3): IMPORTANT: The Expo service is declared in the expo-notifications *library*, WHY: When multiple services are registered for…, { withAndroidManifest }

### Community 128 - "LeaveRequestForm"
Cohesion: 0.67
Nodes (4): getDateRange(), LeaveRequestForm(), ymd(), addLeavesBatch()

### Community 129 - "chat.ts"
Cohesion: 0.50
Nodes (3): ChatAttachment, ChatMessage, ChatReaction

## Knowledge Gaps
- **668 isolated node(s):** `versionParts`, `TabBarButtonProps`, `WEEKDAYS`, `EMPTY_ENTRIES`, `EMPTY_LEAVES` (+663 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **63 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `useTheme()` connect `useTheme` to `LeaveRequestForm`, `attendance.tsx`, `TopBar.tsx`, `features.ts`, `admin.ts`, `emojiStore.ts`, `[conversationId].tsx`, `organization.tsx`, `app/index.tsx`, `DatePicker.tsx`, `useAuth`, `IncomingCallListener.tsx`, `tasks/[id].tsx`, `team.tsx`, `[code].tsx`, `SharedMediaGallery.tsx`, `tasks.tsx`, `LeavesTab.tsx`, `org-settings.tsx`, `add-people.tsx`, `compensation.tsx`, `chat/index.ts`, `org-chart.tsx`, `app/_layout.tsx`, `profile.tsx`, `tenants/[id].tsx`, `user/[id].tsx`, `salary-slips.tsx`, `chat/[id].tsx`, `(tabs)/index.tsx`, `theme.ts`, `Theme`, `ChatAvatar.tsx`, `saved.tsx`, `calendar.tsx`, `admins.tsx`, `FilePreview.tsx`, `insights.tsx`, `mediaCache.ts`, `notesUtils.ts`, `list.tsx`, `updater.ts`, `chat.tsx`, `notes/[id].tsx`, `useDialog`, `tenants/index.tsx`, `CallControls.tsx`, `RecentMediaStrip.tsx`, `create.tsx`, `ClockInVerifyModal.tsx`, `ServiceDeskTab.tsx`, `[userId].tsx`, `settings.tsx`, `leaves.tsx`, `ClockOutVerifyModal.tsx`, `WorkTimerCard.tsx`, `app/search.tsx`, `NativeSelectField.tsx`, `admin/audit.tsx`, `integrations.tsx`, `VerifyError.tsx`, `projects.tsx`, `api.ts`, `admin/index.tsx`, `tokenStore.ts`, `Composer.tsx`, `NativeSwitch.tsx`, `MonthPicker.tsx`, `MediaEditor.tsx`, `PendingRequestsList.tsx`, `more.tsx`, `ChatTabSwitcher.tsx`?**
  _High betweenness centrality (0.185) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `@config-plugins/react-native-webrtc`, `expo`, `expo-build-properties`, `expo-camera`, `expo-clipboard`, `expo-constants`, `expo-document-picker`, `expo-file-system`, `scripts`, `expo-font`, `@expo-google-fonts/inter`, `@expo-google-fonts/pacifico`, `expo-image`, `expo-image-manipulator`, `expo-image-picker`, `expo-intent-launcher`, `expo-keep-awake`, `expo-linear-gradient`, `expo-linking`, `expo-local-authentication`, `expo-location`, `expo-notifications`, `expo-router`, `expo-secure-store`, `expo-splash-screen`, `expo-status-bar`, `@expo/ui`, `expo-video-thumbnails`, `@notifee/react-native`, `react`, `react-dom`, `react-native`, `react-native-callkeep`, `@react-native-firebase/app`, `@react-native-firebase/messaging`, `react-native-gesture-handler`, `react-native-incall-manager`, `@react-native/metro-config`, `react-native-mmkv`, `react-native-nitro-modules`, `react-native-reanimated`, `react-native-safe-area-context`, `react-native-svg`, `react-native-view-shot`, `react-native-web`, `react-native-webrtc`, `react-native-webview`, `react-native-wheel-color-picker`, `react-native-worklets`, `@shopify/flash-list`, `@tanstack/query-core`, `@tanstack/react-query-persist-client`, `zustand`, `expo-video`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **Why does `AuthProvider()` connect `AuthContext.tsx` to `react`, `api.ts`, `app/index.tsx`, `tokenStore.ts`, `uploadUrl`, `mediaCache.ts`, `app/_layout.tsx`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **What connects `versionParts`, `TabBarButtonProps`, `WEEKDAYS` to the rest of the system?**
  _668 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `notifeeService.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0676056338028169 - nodes in this community are weakly interconnected._
- **Should `attendance.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.055178652193577565 - nodes in this community are weakly interconnected._
- **Should `TopBar.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.050595238095238096 - nodes in this community are weakly interconnected._