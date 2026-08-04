# Graph Report - server  (2026-08-04)

## Corpus Check
- 168 files · ~272,564 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1900 nodes · 3287 edges · 116 communities (96 shown, 20 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 42 edges (avg confidence: 0.54)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `769fd5bd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- tenants.ts
- server/index.ts
- redis.ts
- compensation.ts
- routes/export.ts
- ws.ts
- meetings.ts
- tenantManager.ts
- compilerOptions
- devDependencies
- rbac.ts
- planCatalog.ts
- logger.ts
- leaves.ts
- routes/auth.ts
- wsMetrics.ts
- mailer.ts
- profile.ts
- wsIdempotency.ts
- tracker.ts
- migrationRunner.ts
- chat.ts
- status/index.ts
- masterQuery
- admin.ts
- backlog.ts
- resolver.ts
- routes/agile.ts
- branding.ts
- integrations.ts
- repository.ts
- github.ts
- dependencies
- webhooks.ts
- chatMessage.ts
- jobs.ts
- manager.ts
- pushNotifications.ts
- tenant.ts
- access.ts
- package.json
- crud.ts
- detail.ts
- tasks/index.ts
- routes/sprints.ts
- wsValidate.ts
- customFields.ts
- carryForward.ts
- tasks/sprints.ts
- serviceDesk.ts
- comments.ts
- sprintScheduler.ts
- sendToUser
- webauthn.routes.test.ts
- coturn.ts
- face.ts
- app
- impersonationAudit.ts
- requireTenant
- jest
- notifications.ts
- chatMediaPipeline.ts
- calendar.routes.test.ts
- profile.routes.test.ts
- timezone.ts
- status.ts
- index.spec.ts
- leavePolicy.routes.test.ts
- leaves.routes.test.ts
- manager.routes.test.ts
- notes.routes.test.ts
- organization.routes.test.ts
- sprints.routes.test.ts
- tasks.routes.test.ts
- tracker.routes.test.ts
- middleware/auth.ts
- Status Service
- admin.routes.test.ts
- auth.routes.test.ts
- biometric.routes.test.ts
- groupPerms.ts
- calendar.ts
- cache.ts
- approver.ts
- export.routes.test.ts
- geo.ts
- notifications.routes.test.ts
- password.ts
- ws.relayAuthz.test.ts
- broadcaster.ts
- chatMediaMetadata.ts
- moduleFileExtensions
- ManualStatus
- migration.ts
- agileGating.test.ts
- express.d.ts
- bullmq
- cookie-parser
- cors
- dotenv
- express
- firebase-admin
- helmet
- @hocuspocus/extension-database
- json2csv
- nodemailer
- pdfkit
- pg
- pino-pretty
- qrcode
- rate-limit-redis
- @simplewebauthn/server
- ws
- mobileMediaDimensionsPolicy.test.ts

## God Nodes (most connected - your core abstractions)
1. `masterQuery` - 55 edges
2. `logger` - 43 edges
3. `loadUserContext()` - 41 edges
4. `compilerOptions` - 29 edges
5. `getTenantPool()` - 28 edges
6. `requireTenant()` - 25 edges
7. `handleChatMessage()` - 23 edges
8. `sendToUser()` - 23 edges
9. `app` - 21 edges
10. `requireRole()` - 17 edges

## Surprising Connections (you probably didn't know these)
- `sanitizePlanCatalog()` --indirect_call--> `key()`  [INFERRED]
  server/utils/planCatalog.ts → server/services/status/cache.ts
- `setPresencePreference()` --calls--> `isPresencePreference()`  [EXTRACTED]
  server/services/status/repository.ts → server/services/status/constants.ts
- `evictIfNeeded()` --indirect_call--> `entry()`  [INFERRED]
  server/utils/tenantManager.ts → server/__tests__/timeCalc.test.ts
- `waitForDatabase()` --references--> `pool`  [EXTRACTED]
  server/migrate.ts → server/db.ts
- `runRetentionCleanup()` --calls--> `masterQuery`  [EXTRACTED]
  server/jobs.ts → server/db.ts

## Import Cycles
- None detected.

## Communities (116 total, 20 thin omitted)

### Community 0 - "tenants.ts"
Cohesion: 0.04
Nodes (59): APPROVER_ROLES, auth, {
    generateApprovalCode, hashApprovalCode,
    getImpersonationPolicy, computeEffectiveStatus,
    expireStaleRequests, getActiveSession,
}, { loadUserContext, requireRole }, { logger }, { logPlatformAction, updatePlatformAuditLog }, { masterQuery }, publicRow() (+51 more)

### Community 1 - "server/index.ts"
Cohesion: 0.04
Nodes (58): adminRoutes, agileRoutes, apiLimiter, authLimiter, authMiddleware, authRoutes, autoClockOut(), autoClockOutForDb() (+50 more)

### Community 2 - "redis.ts"
Cohesion: 0.06
Nodes (50): attachFailFast(), del(), delPattern(), get(), getActiveSprint(), getMeetingParticipants(), getOnlineUsers(), getOrgConfig() (+42 more)

### Community 3 - "compensation.ts"
Cohesion: 0.05
Nodes (41): cleanupTokens(), auth, { calculateAttendance }, CTC_DEFAULTS, { encrypt, decrypt, maskAccountNumber }, { getPayoutService }, { loadUserContext, requireRole, getVisibleUserIds }, { logger } (+33 more)

### Community 4 - "routes/export.ts"
Cohesion: 0.07
Nodes (41): auth, { computeFloorMs, computeBreakMs, endOfLocalDayMs }, DAY_TYPE_LABEL, DUR_LABEL, { getOffsetMin }, LEAVE_TYPE_LABEL, { loadUserContext, requireRole, getVisibleUserIds }, { logger } (+33 more)

### Community 5 - "ws.ts"
Cohesion: 0.07
Nodes (45): createCollaborationServer(), logPushCallLifecycle(), bufferCallSignal(), BufferedCallSignals, BufferedMeetingPeerSignals, BufferedMeetingSignals, bufferMeetingSignal(), _callSignalBuffers (+37 more)

### Community 6 - "meetings.ts"
Cohesion: 0.05
Nodes (36): activeBroadcasts, auth, BroadcastRecord, crypto, DbLike, { loadUserContext }, meetingPerms, { notifyByEmail } (+28 more)

### Community 7 - "tenantManager.ts"
Cohesion: 0.07
Nodes (39): initDB(), initMasterDB(), initTenantSchema(), makePoolQuery(), makePoolTransaction(), masterTransaction, pool, NOTE: SMTP + branding keys (`smtp_*`, `brand_*`) used to be seeded (+31 more)

### Community 8 - "compilerOptions"
Cohesion: 0.05
Nodes (39): ES2022, jest, uploads, compilerOptions, allowJs, allowSyntheticDefaultImports, alwaysStrict, checkJs (+31 more)

### Community 9 - "devDependencies"
Cohesion: 0.05
Nodes (39): jest, nodemon, devDependencies, jest, nodemon, supertest, ts-jest, tsx (+31 more)

### Community 10 - "rbac.ts"
Cohesion: 0.08
Nodes (29): DbLike, DEFAULT_TENANT_ROLES, getRoleLabels(), getTenantRolesMap(), getVisibleUserIds(), levelForRole(), loadUserContext(), ORG_ROLES (+21 more)

### Community 11 - "planCatalog.ts"
Cohesion: 0.09
Nodes (32): { getTenantById }, { getTenantPool }, { logger }, { masterQuery }, NotePage, { PLANS, FEATURE_LABELS }, PoolLike, router (+24 more)

### Community 12 - "logger.ts"
Cohesion: 0.07
Nodes (26): envPath, main(), waitForDatabase(), getTenantDb(), resolveDefaultDomainUser(), auth, crypto, DbLike (+18 more)

### Community 13 - "leaves.ts"
Cohesion: 0.07
Nodes (23): requireSameOrg(), auth, BalanceRow, DbLike, getAccruedQuota(), initializeBalances(), { loadUserContext, requireRole, requireSameOrg }, PolicyRow (+15 more)

### Community 14 - "routes/auth.ts"
Cohesion: 0.07
Nodes (26): auth, bcrypt, BIOMETRIC_PLATFORMS, { cookieOptions }, createSession(), crypto, finishLogin(), {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} (+18 more)

### Community 15 - "wsMetrics.ts"
Cohesion: 0.07
Nodes (21): { app }, jwt, mockQuery, mockTransaction, request, wsMetrics, wsMetrics, CallAction (+13 more)

### Community 16 - "mailer.ts"
Cohesion: 0.11
Nodes (30): RFC-2047, RFC-5322, applyBranding(), Branding, BRANDING_CACHE, BrandingOverride, buildRawMessage(), cacheKey() (+22 more)

### Community 17 - "profile.ts"
Cohesion: 0.07
Nodes (26): ALLOWED_PRESETS, auth, bcrypt, { cookieOptions }, DbLike, fs, { getUploadDir, getUploadUrl, UPLOADS_ROOT }, { isValidDescriptor, isPlausibleDescriptor, parseDescriptor, compareDescriptors, FACE_DESCRIPTOR_LENGTH } (+18 more)

### Community 18 - "wsIdempotency.ts"
Cohesion: 0.10
Nodes (18): { withIdempotentCallAction, IdempotencyCache }, { withIdempotentCallAction, IdempotencyCache }, { withIdempotency, withIdempotentCallAction, IdempotencyCache }, { withIdempotency, IdempotencyCache, defaultCache }, buildKey(), CacheEntry, CacheOptions, CacheSnapshot (+10 more)

### Community 19 - "tracker.ts"
Cohesion: 0.08
Nodes (23): auth, bumpFaceFailCount(), clearFaceFailCount(), { computeStatus, computeDaySummary, endOfLocalDayMs }, DbLike, faceKey(), { findApprover }, getFaceFailCount() (+15 more)

### Community 20 - "migrationRunner.ts"
Cohesion: 0.14
Nodes (14): bootstrap(), PushNotificationService, QueryFn, Migration, MigrationOpts, MigrationResult, MIGRATIONS, NOTE: the predicate must NOT reference NOW()/CURRENT_TIMESTAMP — (+6 more)

### Community 21 - "chat.ts"
Cohesion: 0.07
Nodes (21): ALLOWED_TYPES, auth, { buildIceServers }, { canDo, loadGroupContext }, chatUpload, DbLike, fs, { getLocalToday, getTzModifier } (+13 more)

### Community 22 - "status/index.ts"
Cohesion: 0.18
Nodes (26): ACTIVITIES, applyChange(), assertCtx(), clearActivityForRef(), clearSessionActivity(), closeAllSessions(), closeSession(), DbLike (+18 more)

### Community 23 - "masterQuery"
Cohesion: 0.13
Nodes (24): masterQuery, invalidateMaintenanceCache(), { isMaintenanceMode, getMaintenanceMessage }, maintenanceModeMiddleware(), refreshCache(), verifyActorPassword(), DEFAULTS, getAllowedEmailDomains() (+16 more)

### Community 24 - "admin.ts"
Cohesion: 0.08
Nodes (22): RFC-4180, canManageUser(), ApprovalEntry, auth, bcrypt, DbLike, { getOffsetMin, getTzModifier }, importUpload (+14 more)

### Community 25 - "backlog.ts"
Cohesion: 0.10
Nodes (23): auth, { canAccessTask }, DbLike, { enrichTasks }, { loadUserContext }, { logHistory }, { notifyByEmail }, router (+15 more)

### Community 26 - "resolver.ts"
Cohesion: 0.16
Nodes (21): ACTIVITIES, Activity, EFFECTIVE_STATUSES, EffectiveStatus, isManualStatus(), isPresencePreference(), PresencePreference, SOURCES (+13 more)

### Community 27 - "routes/agile.ts"
Cohesion: 0.12
Nodes (19): isAgileEditor(), isAgileEditorRole(), isAgileReviewerRole(), requireAgileEditor(), ROLES_THAT_CAN_EDIT_AGILE, ROLES_THAT_CAN_REVIEW_AGILE_REQUESTS, auth, DbLike (+11 more)

### Community 28 - "branding.ts"
Cohesion: 0.10
Nodes (20): auth, fs, { getUploadDir, getUploadUrl, UPLOADS_ROOT }, { loadUserContext, requireRole, requireSameOrg }, { logAction }, multer, MulterCb, path (+12 more)

### Community 29 - "integrations.ts"
Cohesion: 0.10
Nodes (19): auth, crypto, DbLike, github, { loadUserContext, requireRole }, { logAction }, { requireTenant, requireFeature }, router (+11 more)

### Community 30 - "repository.ts"
Cohesion: 0.11
Nodes (14): isActivity(), isSource(), Source, ApplyChangeOpts, clearActivityByRef(), DbLike, getOpenSessions(), getOpenSessionsBulk() (+6 more)

### Community 31 - "github.ts"
Cohesion: 0.13
Nodes (17): buildAuthorizeUrl(), callbackUrl(), deleteRepoWebhook(), ensureRepoWebhook(), exchangeCodeForToken(), getViewer(), gh(), GitHubApiError (+9 more)

### Community 32 - "dependencies"
Cohesion: 0.10
Nodes (21): bcryptjs, cookie, express-rate-limit, @hocuspocus/server, ioredis, jsonwebtoken, multer, dependencies (+13 more)

### Community 33 - "webhooks.ts"
Cohesion: 0.12
Nodes (16): DbLike, extractIssueKeys(), formatIssueKey(), resolveIssueKeys(), crypto, DbLike, { extractIssueKeys, resolveIssueKeys }, { getTenantPool } (+8 more)

### Community 34 - "chatMessage.ts"
Cohesion: 0.12
Nodes (16): { chatMessage }, redis, ADR-0009, chatMessage(), ChatMessageArgs, chatMessageSchema, DbLike, getTotalUnread() (+8 more)

### Community 35 - "jobs.ts"
Cohesion: 0.19
Nodes (18): ChatMediaPipelineJob, enqueueChatMediaPipelineJob(), expireStaleRingingCalls(), fallbackIntervals, initJobs(), InitJobsOpts, pruneStaleInspectorUsers(), Query (+10 more)

### Community 36 - "manager.ts"
Cohesion: 0.13
Nodes (17): auth, { computeFloorMs, computeBreakMs, endOfLocalDayMs }, DbLike, { getLocalToday, getTzModifier, getLocalDateFromTs, getOffsetMin }, { loadUserContext, requireRole, getVisibleUserIds, ROLE_LEVEL }, { logAction }, { logger }, { notifyByEmail } (+9 more)

### Community 37 - "pushNotifications.ts"
Cohesion: 0.13
Nodes (14): FCMPayload, pushNotifications, IMPORTANT: Incoming-call pushes are DATA-ONLY (no top-level, IMPORTANT: Like message pushes, alert pushes are DATA-ONLY on Android, { pushNotifications }, sendEachForMulticast, { pushNotifications }, sendEachForMulticast (+6 more)

### Community 38 - "tenant.ts"
Cohesion: 0.14
Nodes (13): attachMasterDb(), attachTenantDb(), requireFeature(), resolveFromDomain(), resolveFromJwt(), resolveTenant(), auth, DbLike (+5 more)

### Community 39 - "access.ts"
Cohesion: 0.13
Nodes (14): auth, { loadAccessibleTask }, { loadUserContext }, router, auth, { loadAccessibleTask }, { loadUserContext }, router (+6 more)

### Community 40 - "package.json"
Cohesion: 0.12
Nodes (16): author, description, keywords, license, main, name, scripts, build (+8 more)

### Community 41 - "crud.ts"
Cohesion: 0.12
Nodes (15): auth, { canAccessTask }, DbLike, { enrichTasks }, { getLocalToday }, { loadUserContext }, { logAction }, { logHistory } (+7 more)

### Community 42 - "detail.ts"
Cohesion: 0.15
Nodes (14): auth, { canAccessTask }, { enrichTasks }, { loadUserContext }, router, canAccessTask(), DbLike, enrichTasks() (+6 more)

### Community 43 - "tasks/index.ts"
Cohesion: 0.12
Nodes (16): backlogRouter, blockersRouter, carryForwardRouter, commentsRouter, criteriaRouter, crudRouter, dependenciesRouter, detailRouter (+8 more)

### Community 44 - "routes/sprints.ts"
Cohesion: 0.12
Nodes (11): requireRole(), authMiddleware, { loadUserContext, requireRole }, router, wsMetrics, auth, { loadUserContext, requireRole }, { logger } (+3 more)

### Community 45 - "wsValidate.ts"
Cohesion: 0.15
Nodes (12): ADR-0005, { schema, validate }, NumOptions, OptionalOnly, Schema, Shape, StrOptions, validate() (+4 more)

### Community 46 - "customFields.ts"
Cohesion: 0.13
Nodes (8): auth, DbLike, FIELD_TYPES, { isAgileEditorRole }, { loadUserContext }, { logAction }, { requireTenant, requireFeature }, router

### Community 47 - "carryForward.ts"
Cohesion: 0.15
Nodes (12): auth, DbLike, { getLocalToday }, { loadUserContext }, { logHistory }, router, logHistory(), auth (+4 more)

### Community 48 - "tasks/sprints.ts"
Cohesion: 0.16
Nodes (13): DbLike, fmt(), getTodayStr(), materialiseTeamSprints(), auth, { canAccessTask }, { enrichTasks }, { loadUserContext } (+5 more)

### Community 49 - "serviceDesk.ts"
Cohesion: 0.16
Nodes (13): auth, getDefaultTenantDb(), { getTenantPool }, isDefaultTenant(), { loadUserContext }, { logger }, { masterQuery }, resolveDefaultTenant() (+5 more)

### Community 50 - "comments.ts"
Cohesion: 0.14
Nodes (12): ALLOWED_TYPES, auth, { canAccessTask }, commentUpload, { getUploadDir, getUploadUrl }, { loadUserContext }, { logHistory }, multer (+4 more)

### Community 51 - "sprintScheduler.ts"
Cohesion: 0.30
Nodes (11): completeAndRollover(), computeCurrentWindow(), Db, fmtDateUTC(), parseDateUTC(), Query, reconcileTeam(), runSprintLifecycle() (+3 more)

### Community 52 - "sendToUser"
Cohesion: 0.23
Nodes (8): emitSystemMessage(), insertSystemMessage(), broadcast(), clientKey(), deliverLocal(), ExtWS, sendToUser(), setupWebSocket()

### Community 53 - "webauthn.routes.test.ts"
Cohesion: 0.15
Nodes (10): { app }, CSRF, jwt, mockGenAuthOpts, mockGenRegOpts, mockQuery, mockTransaction, mockVerifyAuth (+2 more)

### Community 54 - "coturn.ts"
Cohesion: 0.21
Nodes (12): buildIceServers(), buildStunServers(), buildTurnUrlList(), cfCredCache, CfCredCacheEntry, DEFAULT_STUN, EphemeralCreds, fetchCloudflareCreds() (+4 more)

### Community 55 - "face.ts"
Cohesion: 0.29
Nodes (9): {
    isValidDescriptor,
    parseDescriptor,
    euclideanDistance,
    compareDescriptors,
    FACE_DESCRIPTOR_LENGTH,
    DEFAULT_MATCH_THRESHOLD,
}, compareDescriptors(), CompareResult, DescriptorInput, euclideanDistance(), isDescriptorReplay(), isPlausibleDescriptor(), isValidDescriptor() (+1 more)

### Community 56 - "app"
Cohesion: 0.18
Nodes (7): app, { app }, request, { app }, jwt, mockQuery, request

### Community 57 - "impersonationAudit.ts"
Cohesion: 0.24
Nodes (10): AuditSession, endSession(), getSession(), impersonationAudit, ImpersonationAuditMiddleware, SessionAction, sessionKey(), sessions (+2 more)

### Community 58 - "requireTenant"
Cohesion: 0.20
Nodes (9): requireTenant(), auth, fetchGiphy(), GiphyItem, { loadUserContext }, normalize(), NormalizedItem, { requireTenant } (+1 more)

### Community 59 - "jest"
Cohesion: 0.18
Nodes (11): jest, preset, setupFiles, testEnvironment, testPathIgnorePatterns, transform, /dist/, /node_modules/ (+3 more)

### Community 60 - "notifications.ts"
Cohesion: 0.22
Nodes (9): auth, { loadUserContext }, { logger }, normalizeMetricEvent(), NotificationMetricEventInput, optionalNumber(), optionalString(), { requireTenant } (+1 more)

### Community 61 - "chatMediaPipeline.ts"
Cohesion: 0.25
Nodes (10): broadcastMediaJobUpdate(), computeSha256(), MediaJobNotifyInput, MediaJobStage, MediaJobStatus, processChatMediaJob(), QueryFn, QueryResult (+2 more)

### Community 62 - "calendar.routes.test.ts"
Cohesion: 0.18
Nodes (7): { app }, CSRF, jwt, mockQuery, mockTransaction, mockTxClient, request

### Community 63 - "profile.routes.test.ts"
Cohesion: 0.18
Nodes (7): { app }, CSRF, jwt, mockQuery, mockTransaction, mockTxClient, request

### Community 64 - "timezone.ts"
Cohesion: 0.42
Nodes (8): { clampOffset, getTzModifier, getLocalToday, getLocalYesterday, getLocalDow, getOffsetMin, getLocalDateFromTs }, clampOffset(), getLocalDateFromTs(), getLocalDow(), getLocalToday(), getLocalYesterday(), getOffsetMin(), getTzModifier()

### Community 65 - "status.ts"
Cohesion: 0.20
Nodes (8): auth, { MANUAL_STATUSES, PRESENCE_PREFERENCES }, { requireTenant }, router, StatusCtx, statusService, MANUAL_STATUSES, PRESENCE_PREFERENCES

### Community 66 - "index.spec.ts"
Cohesion: 0.20
Nodes (8): FakeDbState, FakeEvent, FakeSession, FakeUser, QueryResult, SentMessage, sentMessages, StatusCtx

### Community 67 - "leavePolicy.routes.test.ts"
Cohesion: 0.20
Nodes (7): { app }, CSRF, jwt, mockQuery, mockTransaction, mockTxClient, request

### Community 68 - "leaves.routes.test.ts"
Cohesion: 0.20
Nodes (7): { app }, CSRF, jwt, mockQuery, mockTransaction, mockTxClient, request

### Community 69 - "manager.routes.test.ts"
Cohesion: 0.20
Nodes (7): { app }, CSRF, jwt, mockQuery, mockTransaction, mockTxClient, request

### Community 70 - "notes.routes.test.ts"
Cohesion: 0.20
Nodes (7): { app }, CSRF, jwt, mockQuery, mockTransaction, mockTxClient, request

### Community 71 - "organization.routes.test.ts"
Cohesion: 0.20
Nodes (7): { app }, CSRF, jwt, mockQuery, mockTransaction, mockTxClient, request

### Community 72 - "sprints.routes.test.ts"
Cohesion: 0.20
Nodes (7): { app }, CSRF, jwt, mockQuery, mockTransaction, mockTxClient, request

### Community 73 - "tasks.routes.test.ts"
Cohesion: 0.20
Nodes (7): { app }, CSRF, jwt, mockQuery, mockTransaction, mockTxClient, request

### Community 74 - "tracker.routes.test.ts"
Cohesion: 0.20
Nodes (7): { app }, CSRF, jwt, mockQuery, mockTransaction, mockTxClient, request

### Community 75 - "middleware/auth.ts"
Cohesion: 0.25
Nodes (7): authMiddleware(), checkImpersonationStillAllowed(), _impCache, jwt, auth, { loadUserContext }, router

### Community 76 - "Status Service"
Cohesion: 0.22
Nodes (8): Debugging a "why am I showing X?" report, How do I add a new activity type? (e.g. `presenting`), Module layout (one file = one responsibility), Precedence (resolver, in order), Public API (`StatusService`), State model, Status Service, Why this exists

### Community 77 - "admin.routes.test.ts"
Cohesion: 0.22
Nodes (6): { app }, CSRF, jwt, mockQuery, mockTransaction, request

### Community 78 - "auth.routes.test.ts"
Cohesion: 0.22
Nodes (7): { app }, bcrypt, CSRF, jwt, mockQuery, mockTransaction, request

### Community 79 - "biometric.routes.test.ts"
Cohesion: 0.22
Nodes (7): { app }, bcrypt, CSRF, jwt, mockQuery, mockTransaction, request

### Community 80 - "groupPerms.ts"
Cohesion: 0.28
Nodes (8): canDo(), GOVERNANCE_ACTIONS, GroupAction, GroupContext, GroupPolicy, GroupRole, isAdminish(), loadGroupContext()

### Community 81 - "calendar.ts"
Cohesion: 0.25
Nodes (7): auth, { getOffsetMin }, { loadUserContext }, { notifyByEmail }, { requireTenant }, router, { sendToUser }

### Community 82 - "cache.ts"
Cohesion: 0.39
Nodes (7): getEffective(), getEffectiveBulk(), invalidate(), key(), setEffective(), updateImpersonationPolicy(), updatePlatformConfig()

### Community 83 - "approver.ts"
Cohesion: 0.29
Nodes (6): { findApprover }, mockDb, mockQuery, ApproverRow, DbLike, findApprover()

### Community 84 - "export.routes.test.ts"
Cohesion: 0.25
Nodes (5): { app }, CSRF, jwt, mockQuery, request

### Community 85 - "geo.ts"
Cohesion: 0.54
Nodes (6): { haversineMeters, isWithinGeofence, isValidLat, isValidLng }, haversineMeters(), isValidLat(), isValidLng(), isWithinGeofence(), toRad()

### Community 86 - "notifications.routes.test.ts"
Cohesion: 0.25
Nodes (5): { app }, CSRF, jwt, mockQuery, request

### Community 87 - "password.ts"
Cohesion: 0.43
Nodes (5): { validatePassword, validateUsername }, loadPolicy(), PasswordPolicy, validatePassword(), validateUsername()

### Community 88 - "ws.relayAuthz.test.ts"
Cohesion: 0.29
Nodes (4): { handleChatMessage }, NOTE: ws.js keeps a short-TTL in-memory membership cache keyed by, redis, ws

### Community 89 - "broadcaster.ts"
Cohesion: 0.40
Nodes (5): BroadcastArgs, broadcastUserStatus(), DbLike, getWs(), WsModule

### Community 90 - "chatMediaMetadata.ts"
Cohesion: 0.53
Nodes (4): buildUploadedMediaMetadata(), ChatMediaMetadata, copyForwardedMediaMetadata(), validDimensionPair()

### Community 91 - "moduleFileExtensions"
Cohesion: 0.40
Nodes (5): moduleFileExtensions, js, node, ts, json

### Community 92 - "ManualStatus"
Cohesion: 0.40
Nodes (5): ManualStatus, SetManualStatusOpts, StatusPayload, SetManualStatusOpts, UserPrefs

### Community 94 - "agileGating.test.ts"
Cohesion: 0.67
Nodes (3): express, makeApp(), request

## Knowledge Gaps
- **999 isolated node(s):** `jwt`, `request`, `mockQuery`, `mockTransaction`, `{ app }` (+994 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **20 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `logger` connect `logger.ts` to `tenants.ts`, `server/index.ts`, `redis.ts`, `compensation.ts`, `routes/export.ts`, `ws.ts`, `tenantManager.ts`, `rbac.ts`, `planCatalog.ts`, `leaves.ts`, `routes/auth.ts`, `mailer.ts`, `profile.ts`, `tracker.ts`, `migrationRunner.ts`, `masterQuery`, `admin.ts`, `integrations.ts`, `github.ts`, `webhooks.ts`, `chatMessage.ts`, `jobs.ts`, `manager.ts`, `pushNotifications.ts`, `tenant.ts`, `routes/sprints.ts`, `serviceDesk.ts`, `sprintScheduler.ts`, `notifications.ts`, `timezone.ts`, `middleware/auth.ts`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Why does `loadUserContext()` connect `rbac.ts` to `tenants.ts`, `compensation.ts`, `routes/export.ts`, `meetings.ts`, `leaves.ts`, `profile.ts`, `tracker.ts`, `chat.ts`, `admin.ts`, `backlog.ts`, `routes/agile.ts`, `branding.ts`, `integrations.ts`, `manager.ts`, `tenant.ts`, `access.ts`, `crud.ts`, `detail.ts`, `routes/sprints.ts`, `customFields.ts`, `carryForward.ts`, `tasks/sprints.ts`, `serviceDesk.ts`, `comments.ts`, `requireTenant`, `notifications.ts`, `middleware/auth.ts`, `calendar.ts`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `requireTenant()` connect `requireTenant` to `compensation.ts`, `routes/export.ts`, `meetings.ts`, `rbac.ts`, `logger.ts`, `leaves.ts`, `profile.ts`, `tracker.ts`, `chat.ts`, `admin.ts`, `routes/agile.ts`, `branding.ts`, `integrations.ts`, `manager.ts`, `tenant.ts`, `tasks/index.ts`, `routes/sprints.ts`, `customFields.ts`, `notifications.ts`, `status.ts`, `calendar.ts`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **What connects `jwt`, `request`, `mockQuery` to the rest of the system?**
  _999 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `tenants.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.04375 - nodes in this community are weakly interconnected._
- **Should `server/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.03728813559322034 - nodes in this community are weakly interconnected._
- **Should `redis.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06428988895382817 - nodes in this community are weakly interconnected._