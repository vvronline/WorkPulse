# WorkPulse Enterprise Restructuring and Scaling Plan

**Status:** Proposed  
**Last updated:** 2026-07-22  
**Scope:** Repository organization, deployable boundaries, multi-tenant data placement, infrastructure, scaling, availability, backup, security, observability, and delivery practices.

---

## 1. Executive decision

WorkPulse should remain in **one monorepo**. The web application, API, mobile application, Electron desktop application, shared contracts, and infrastructure are closely related and benefit from atomic changes and coordinated validation.

The repository should not, however, continue to imply that every backend responsibility must run in one process or scale as one unit. The long-term target is:

- One structured monorepo.
- A modular monolith for business logic rather than premature domain microservices.
- Several independently deployable runtime processes where workloads have materially different scaling and failure characteristics.
- Managed PostgreSQL, Redis, object storage, load balancing, and backups.
- Cluster-aware placement of tenant databases, including dedicated placement for large or regulated tenants.

The core distinction is:

> **Source-code boundaries, deployment boundaries, and tenant/data boundaries are separate architectural decisions.**

Keeping source in one repository does not require deploying it in one container, using one database cluster, or scaling every workload together.

### 1.1 Recommended backend deployment boundaries

Over time, split the current server runtime into:

1. **API** — stateless HTTP application endpoints.
2. **Realtime** — WebSocket connections, presence, chat delivery, and WebRTC signaling.
3. **Collaboration** — Hocuspocus/Yjs connections and persistence.
4. **Workers** — BullMQ job consumers and scheduled workloads.
5. **Migration controller** — controlled master and tenant schema migrations.

These processes may initially share internal packages and the same release version. They do not need to become independent business microservices.

---

## 2. Goals and non-goals

### 2.1 Goals

- Preserve fast development across web, mobile, desktop, and backend clients.
- Allow API, realtime, collaboration, and background jobs to scale independently.
- Keep tenant isolation explicit and testable.
- Support growth from one PostgreSQL cluster to a fleet of shared and dedicated clusters.
- Remove local disk and process memory as production correctness dependencies.
- Establish tested backup and restore procedures with defined recovery objectives.
- Support rolling deployments without running fleet-wide migrations in every application replica.
- Make failures observable by service, release, region, database cluster, tenant, and job.
- Provide a staged migration path without a disruptive rewrite.

### 2.2 Non-goals

- Splitting WorkPulse into multiple source repositories.
- Immediately rewriting the backend as many microservices.
- Introducing Kubernetes before operational requirements justify it.
- Replacing PostgreSQL, Redis, Express, Expo, Electron, or the current realtime stack without evidence.
- Moving every existing file in one large pull request.
- Sharing presentation components between React DOM and React Native when platform differences make that coupling unhelpful.

---

## 3. Current-state assessment

### 3.1 Applications and tooling

The repository currently contains:

| Path | Responsibility |
|---|---|
| `client/` | React/Vite web application and the renderer used by Electron |
| `server/` | Express API, WebSockets, collaboration, jobs, migrations, database access, and upload serving |
| `mobile/` | Expo/React Native application with native modules |
| `desktop/` | Electron shell, native desktop integration, packaging, and updates |
| `infra/` | coturn infrastructure |
| `docs/` | Feature and operational documentation plus ADRs |
| `specs/` | Feature specifications and implementation plans |
| `.github/workflows/` | CI and mobile/desktop release automation |

Each Node project currently has its own installation and lockfile. The root `package.json` identifies the repository as a monorepo but does not define package-manager workspaces or dependency-aware root scripts.

### 3.2 Current production composition

The current production Docker image builds the web client and backend, then runs an Express process that:

- Serves the web application.
- Handles REST APIs.
- Accepts native WebSocket connections.
- Hosts Hocuspocus/Yjs collaboration.
- Starts BullMQ workers and scheduled jobs.
- Runs tenant migrations during deployment/startup.
- Reads and writes uploads from a persistent application volume.

This is appropriate for early deployment and low operational complexity. It becomes a limitation when workloads grow differently or when one workload failure affects all others.

### 3.3 Existing strengths

WorkPulse already has several useful enterprise foundations:

- A master PostgreSQL database for the tenant catalog and platform data.
- A dedicated PostgreSQL database per tenant.
- Per-tenant schema migrations.
- Tenant database pool lifecycle and LRU eviction.
- Tenant-scoped authentication, authorization, rate limits, and upload paths.
- Redis-backed caching and rate limiting.
- Redis Pub/Sub for cross-instance WebSocket delivery.
- BullMQ for durable distributed background work.
- Pino structured logging.
- Health checks and graceful shutdown handling.
- CI for server and web builds/tests.
- Separate mobile and desktop release workflows.

These capabilities should be evolved rather than discarded.

### 3.4 Primary risks and bottlenecks

| Area | Current concern | Long-term impact |
|---|---|---|
| Runtime coupling | API, WS, collaboration, jobs, migration, static assets, and uploads share a process/image | A hot or failing workload affects unrelated functions |
| Static web hosting | Express serves the Vite output | API replicas and bandwidth are consumed by static assets |
| Upload storage | Files live under `server/uploads` on a volume | Complicates horizontal scaling, backup, failover, and regional delivery |
| Migrations | Migrations run before server startup and sweep tenants | Slow or failed tenant migrations can block or destabilize releases |
| Job fallback | Redis failure can cause `setInterval` scheduling | Unsafe when several application replicas independently schedule work |
| Connection budget | Each process may open pools to multiple tenant databases | Replica growth can exhaust PostgreSQL connections before CPU is exhausted |
| Tenant placement | Connections are primarily derived from the master DB endpoint | Prevents clean placement across clusters, providers, or regions |
| Health probe | One endpoint can expose deep tenant migration checks | Load-balancer probes must remain cheap and bounded |
| CI coverage | Normal CI focuses on web and server | Mobile/desktop compatibility regressions may be found late |
| Repository hygiene | Generated `server/dist` output appears tracked | Larger diffs, merge conflicts, and source/build ambiguity |
| Module size | Several API, DB, chat, auth, and WS files are very large | Slower review, weak ownership boundaries, and higher regression risk |

---

## 4. Architecture principles

1. **Monorepo, multiple deployables.** Keep coordinated source together; deploy workloads independently.
2. **Modular monolith first.** Separate code by domain and responsibility before creating network services.
3. **Stateless request handling.** API correctness must not rely on a particular process's memory or disk.
4. **Tenant context is server-derived.** Never allow a client-supplied tenant identifier to override authenticated tenant resolution.
5. **Redis is optional for single-node development, mandatory for scaled production.** A multi-replica topology must not fall back to independent in-memory schedulers, rate limiters, or presence state.
6. **Database changes are backward compatible.** Use expand/migrate/contract changes to support rolling releases.
7. **Backups are proven by restores.** A successful backup task alone is not evidence of recoverability.
8. **Isolation before optimization.** Tenant security and bounded resource use take priority over small performance gains.
9. **Managed infrastructure by default.** Prefer managed databases, Redis, object storage, load balancers, and secret management unless self-hosting is a product requirement.
10. **Complexity must be earned.** Kubernetes and domain microservices require demonstrated operational or scaling needs.

---

## 5. Target repository structure

The following structure is the long-term target. It should be reached incrementally rather than through a single repository-wide move.

```text
WorkPulse/
├── apps/
│   ├── web/                       # Existing React/Vite client
│   ├── mobile/                    # Existing Expo/React Native app
│   ├── desktop/                   # Existing Electron shell
│   ├── api/                       # Stateless Express HTTP entry point
│   ├── realtime/                  # WebSockets, presence, WebRTC signaling
│   ├── collaboration/             # Hocuspocus/Yjs entry point
│   └── worker/                    # BullMQ workers and schedulers
│
├── packages/
│   ├── contracts/                 # API DTOs and REST/WS event schemas
│   ├── domain/                    # Framework-independent domain types/constants
│   ├── validation/                # Shared payload validation
│   ├── auth/                      # Shared auth and authorization primitives
│   ├── database/                  # Master/tenant access and migrations
│   ├── observability/             # Logging, metrics, traces, request context
│   ├── config/                    # Validated environment configuration
│   ├── feature-flags/             # Plans, limits, entitlements, feature resolution
│   ├── test-utils/                # Tenant fixtures, factories, integration helpers
│   ├── eslint-config/             # Shared linting rules
│   └── tsconfig/                  # Shared TypeScript configurations
│
├── infrastructure/
│   ├── docker/                    # Images and Compose resources
│   ├── terraform/                 # Add after selecting a target cloud/provider
│   ├── kubernetes/                # Add only if Kubernetes is adopted
│   ├── monitoring/                # Dashboards, alerts, collectors
│   ├── backup/                    # Backup/restore automation and verification
│   ├── coturn/                    # Existing TURN configuration
│   └── environments/
│       ├── local/
│       ├── staging/
│       └── production/
│
├── tooling/
│   ├── scripts/
│   ├── generators/
│   └── release/
│
├── docs/
│   ├── architecture/
│   ├── operations/
│   ├── security/
│   ├── runbooks/
│   └── adr/
│
├── package.json                   # Workspace definitions and root commands
├── package-lock.json              # One npm workspace lockfile where practical
├── tsconfig.base.json
└── docker-compose.yml
```

### 5.1 Naming

Use scoped workspace names to make ownership and imports explicit:

```text
@workpulse/web
@workpulse/mobile
@workpulse/desktop
@workpulse/api
@workpulse/realtime
@workpulse/worker
@workpulse/contracts
@workpulse/database
```

### 5.2 What should be shared

Good candidates for shared packages:

- REST request and response types.
- WebSocket event envelopes and validation schemas.
- Domain enums and stable identifiers.
- Plan and entitlement definitions.
- Environment configuration parsing.
- Tenant-aware logging context.
- Pure formatting and calculation functions.
- Test fixtures and API contract helpers.

### 5.3 What should not be forced into shared packages

- React DOM and React Native visual components with substantially different behavior.
- Server-only database objects imported into client bundles.
- Platform-specific storage, notifications, media, WebRTC, or authentication code.
- Large generic `utils` packages without clear ownership.
- Abstractions used by only one application.

### 5.4 Mobile structure

The Expo application is established and contains custom native modules. Preserve its existing routing and source conventions during the monorepo move. Moving `mobile/` to `apps/mobile/` must not be combined with an unrelated internal application restructure.

### 5.5 Backend module boundaries before service extraction

Before introducing network service boundaries, reorganize backend code by domain inside shared server packages. A possible pattern is:

```text
packages/domain-modules/src/
├── identity/
├── tenants/
├── attendance/
├── leave/
├── projects/
├── chat/
├── meetings/
├── notes/
├── compensation/
├── notifications/
└── service-desk/
```

Each module can expose application services and route registration while database, transport, and infrastructure concerns remain explicit. Avoid hidden cross-module imports; use exported interfaces or events for meaningful boundaries.

---

## 6. Target runtime architecture

```text
Users and devices
       │
       ▼
┌───────────────────────────────┐
│ DNS + CDN + WAF + edge TLS    │
└───────────────┬───────────────┘
                │
        ┌───────┴─────────┐
        │                 │
        ▼                 ▼
 Static web/CDN      Load balancer / ingress
                          │
          ┌───────────────┼────────────────┐
          │               │                │
          ▼               ▼                ▼
     API replicas   Realtime replicas  Collaboration replicas
          │               │                │
          └───────────────┼────────────────┘
                          │
                   Managed Redis HA
                 cache / pub-sub / queues
                          │
                     Worker replicas
                          │
             ┌────────────┼─────────────┐
             │            │             │
             ▼            ▼             ▼
          Master DB   Tenant DB fleet  Object storage
                                     + private CDN
```

### 6.1 Web application

Deploy Vite output to static hosting/CDN rather than serving it from every API replica.

Benefits:

- Independent web and API scaling.
- Lower API bandwidth and CPU consumption.
- Global edge caching.
- Smaller API images.
- Easier cache control and rollback of web assets.

The Electron application can continue packaging a compatible web build where required.

### 6.2 API process

The API process should:

- Handle HTTP requests and webhooks.
- Resolve authenticated tenant context.
- Use PostgreSQL and Redis through bounded clients.
- Enqueue long-running work.
- Return quickly and remain stateless.

The API process should not:

- Store files on local disk.
- run recurring jobs;
- execute fleet-wide tenant migrations at startup;
- require in-memory cross-request state for correctness; or
- serve the production web bundle.

### 6.3 Realtime process

The realtime process should own:

- WebSocket connection lifecycle.
- Presence heartbeats.
- Chat event delivery.
- Call and meeting signaling.
- Redis Pub/Sub fan-out between replicas.
- Connection and event metrics.

All durable state must be recoverable from PostgreSQL or Redis. Local connection maps are expected, but another process must be able to deliver through Pub/Sub. Sticky sessions may reduce reconnect churn but must not be required for authorization or correctness.

Autoscaling signals should include:

- Open connections per instance.
- Event-loop lag.
- Memory.
- Messages per second.
- Redis Pub/Sub delay or failures.
- Reconnect rate.

### 6.4 Collaboration process

Hocuspocus/Yjs collaboration has different connection, memory, and document-persistence behavior from chat signaling. It can initially remain with realtime, but it should have a dedicated entry point and image target so it can be separated without reorganizing business logic later.

### 6.5 Worker process

Workers should be independently deployable and scalable by queue category. Initial queue groups may include:

- Email and notifications.
- Mobile push.
- Chat media processing.
- Exports and PDF creation.
- Retention and cleanup.
- Tenant provisioning.
- Tenant migrations.
- Scheduled attendance, leave, sprint, and call cleanup.

CPU- or memory-heavy media/PDF work should not compete with latency-sensitive notification jobs.

### 6.6 Migration controller

Run migrations as an explicit release or operations job. It must support:

- An advisory lock or distributed lock to prevent duplicate controllers.
- Bounded tenant concurrency.
- Per-tenant status and duration.
- Resumable retries.
- Canary tenant cohorts.
- Pausing and cancellation between tenants.
- Compatibility checks against the deployed application version.
- A report of tenants on each schema version.

New tenant databases should be created from the latest validated schema or a versioned template, then brought to the desired migration version before activation.

---

## 7. Multi-tenant data architecture

### 7.1 Retain database-per-tenant

The existing database-per-tenant approach remains suitable for WorkPulse because it supports:

- Strong logical isolation.
- Tenant-specific backup and restore.
- Dedicated enterprise capacity.
- Tenant relocation.
- Data residency.
- Per-tenant deletion and export.
- Lower blast radius than a single shared application schema.

Costs that must be managed include migration fan-out, connection count, database fleet operations, and cross-tenant reporting.

### 7.2 Separate control plane and data plane

The master database acts as the control plane and should contain tenant identity, routing, placement, plan, status, and schema metadata. Application data remains in tenant databases.

Introduce concepts equivalent to:

```text
database_clusters
- id
- provider
- region
- writer_endpoint_ref
- reader_endpoint_ref
- credential_ref
- capacity_class
- status
- backup_policy_id
- created_at
- updated_at

tenant_placements
- tenant_id
- cluster_id
- database_name
- placement_tier
- placement_status
- schema_version
- migration_state
- residency_policy
- moved_at
```

Endpoint and credential fields should reference a secret manager. Do not store reusable plaintext connection URLs in ordinary tenant rows.

### 7.3 Placement tiers

#### Shared standard

- Many tenant databases on a managed PostgreSQL cluster.
- Application-level quotas and plan limits.
- Standard backup and recovery objectives.

#### Shared high-capacity

- Fewer tenant databases per cluster.
- Higher connection, storage, queue, and worker allowances.
- Optional read replicas for reporting-heavy tenants.

#### Dedicated enterprise

- Dedicated PostgreSQL cluster or deployment.
- Dedicated encryption key where required.
- Tenant-specific backup retention and restore objectives.
- Optional region choice.
- Optional dedicated worker/realtime pool.
- Controlled maintenance windows.

Tenant tier affects placement and resource policy; it should not require a separate code branch or repository.

### 7.4 Tenant placement and movement

Build placement as an internal control-plane workflow:

1. Select a healthy cluster that satisfies region, tier, and capacity policy.
2. Provision the tenant database and least-privilege role.
3. Apply/validate schema.
4. Register placement atomically.
5. Activate the tenant only after health validation.

Tenant movement should be an explicit runbook/tool with a maintenance or replication strategy:

1. Create the target database.
2. Copy and validate data.
3. Stop or quiesce writes, or synchronize the final delta.
4. Update placement atomically.
5. Clear routing and pool caches.
6. Validate application access.
7. Retain the old copy for a defined rollback window.
8. Securely delete it after approval and retention expiry.

### 7.5 Connection management

The existing LRU pool is appropriate for the current scale but must become cluster-aware. At larger scale:

- Put PgBouncer or a managed pooler in front of tenant clusters.
- Keep per-process tenant pools small.
- Define a global connection budget per deployment.
- Bound concurrently active tenant pools.
- Instrument checkout wait, saturation, query duration, failures, and evictions.
- Prefer transaction pooling only after validating session-dependent SQL behavior.
- Avoid opening a separate large pool for every active tenant on every replica.

Capacity planning must use:

```text
total possible connections = replicas × active tenant pools per replica × pool size
                           + master pools
                           + workers
                           + migration/operations connections
```

Application replicas should never be scaled without considering this connection budget.

### 7.6 Cross-tenant analytics

Do not query every tenant database synchronously from user-facing requests. For platform reporting:

- Emit tenant-scoped events or periodic aggregates.
- Store non-sensitive aggregate data in a reporting store.
- Enforce explicit platform-admin authorization.
- Audit all cross-tenant access.
- Keep the operational master DB from becoming an analytics warehouse.

---

## 8. Load balancing, edge, and proxy design

### 8.1 Responsibilities

Use a managed edge and load-balancing service where possible. It should provide:

- TLS termination and certificate rotation.
- WebSocket upgrade support.
- WAF and DDoS controls.
- Compression and caching where appropriate.
- Request-size limits.
- Per-route timeouts.
- Request IDs and access logs.
- Health/readiness routing.
- Safe rolling deployments.
- Custom-domain validation and routing.

### 8.2 Suggested public endpoints

```text
app.example.com           -> web CDN/static hosting
api.example.com           -> API load balancer
realtime.example.com      -> WebSocket load balancer
collab.example.com        -> collaboration load balancer
files.example.com         -> private object delivery/CDN
turn.example.com          -> coturn
{tenant}.example.com      -> tenant web entry
custom.customer.com       -> verified customer tenant domain
```

Using one origin with path routing is also valid during migration. Separate hostnames make independent scaling, policies, and observability easier later.

### 8.3 Timeouts and limits

Use route-specific policies rather than one global timeout:

- Normal API requests: short bounded timeout.
- Webhooks: short response, enqueue durable processing.
- Exports: enqueue and notify/download later.
- Uploads: direct signed object-storage uploads.
- WebSockets/collaboration: long-lived upgrade connections with heartbeat handling.

### 8.4 Health endpoints

Provide separate endpoints:

| Endpoint type | Purpose | Dependency depth |
|---|---|---|
| Liveness | Process/event loop is alive | None or minimal |
| Readiness | Instance can accept traffic | Required local dependencies only |
| Diagnostics | Operator investigation | Authenticated, detailed dependencies |

Do not iterate every tenant database from a load-balancer readiness probe. Tenant migration fleet status belongs in authenticated operational diagnostics and dashboards.

### 8.5 Caddy

Caddy remains suitable for:

- Local development.
- Small self-hosted installations.
- Simple single-region deployments.

At enterprise scale, prefer a managed load balancer/WAF or a deliberately operated ingress tier. Do not operate a proxy fleet merely because it is technically possible.

---

## 9. Object and file storage

Local application volumes are incompatible with reliable horizontal scaling. Migrate `server/uploads` to S3-compatible object storage such as AWS S3, Cloudflare R2, Azure Blob Storage, Google Cloud Storage, or an approved managed equivalent.

### 9.1 Object key design

Use server-derived tenant and organization identity:

```text
tenants/{tenant-id}/organizations/{org-id}/{category}/{object-id}/{filename}
```

Never trust a client-supplied tenant prefix. Object keys should use stable IDs rather than mutable names.

### 9.2 Upload flow

Preferred flow for suitable file types:

1. Client requests permission to upload.
2. API authenticates the session and resolves tenant/org context.
3. API validates category, expected size, MIME type, plan quota, and permissions.
4. API creates metadata and a short-lived signed upload URL.
5. Client uploads directly to object storage.
6. A worker validates/scans/processes the object.
7. Metadata becomes available only after successful finalization.

The API may proxy small sensitive files when necessary, but proxying should be an explicit exception.

### 9.3 Download flow

Private files should use either:

- Short-lived signed URLs issued after authorization, or
- An authenticated edge/download endpoint.

Do not expose a permanently public bucket merely because paths contain tenant identifiers.

### 9.4 Storage controls

- Encryption at rest and in transit.
- Versioning where recovery requirements justify it.
- Lifecycle policies for temporary and deleted objects.
- Malware scanning for relevant file types.
- Quotas by tenant and plan.
- Audit logs for sensitive downloads.
- Cross-region replication for qualifying tiers.
- Reconciliation jobs between DB metadata and stored objects.

### 9.5 Migration from existing uploads

Use a reversible migration:

1. Introduce a storage-provider abstraction and object metadata.
2. Write new objects to object storage.
3. Continue reading legacy local paths.
4. Backfill existing objects with checksums.
5. Validate counts, size, and checksums by tenant.
6. Change reads to object storage.
7. Retain the old volume through a rollback window.
8. Remove it only after backup and restore validation.

---

## 10. Redis, queues, and distributed state

### 10.1 Production policy

Redis may remain optional for local/single-instance development. It is **mandatory** for horizontally scaled production.

When more than one server replica is active, do not silently fall back to:

- In-memory rate limits.
- Local-only presence state.
- Independent `setInterval` schedules.
- Local-only cache invalidation.
- Local-only WebSocket event delivery.

The application should fail readiness or disable the affected capability according to an explicit production policy.

### 10.2 Redis workload separation

Initially, a managed Redis deployment can support cache, Pub/Sub, rate limits, and BullMQ. Monitor contention and split workloads when required:

- Cache can tolerate eviction.
- Pub/Sub is latency-sensitive.
- Queue data is operationally durable.
- Rate limiting is security and availability related.

Separate instances or clusters should be considered when memory policies, persistence needs, or failure domains conflict.

### 10.3 Queue design

Every job should define:

- Stable job name and versioned payload.
- Tenant ID and trace/request correlation.
- Idempotency key.
- Retry and exponential backoff policy.
- Timeout.
- Dead-letter or failed-job handling.
- Concurrency limits.
- Retention policy.
- Safe behavior if the tenant is suspended/deleted.

Queue depth alone is not enough. Alert on oldest-job age, failure rate, and retry exhaustion.

---

## 11. Backup and disaster recovery

### 11.1 Recovery objectives

Final RPO/RTO values are business and contractual decisions. Use these as initial planning targets:

| Data/system | Initial RPO target | Initial RTO target |
|---|---:|---:|
| Master tenant catalog/control plane | 5–15 minutes | Under 1 hour |
| Dedicated enterprise tenant DB | 5–15 minutes | 1–2 hours |
| Shared standard tenant DB | Up to 1 hour | Up to 4 hours |
| Object storage | Versioning/replication policy | 1–4 hours |
| Redis cache | No durability promise | Rebuild automatically |
| BullMQ operational data | Minutes | Under 1 hour |
| Source and build configuration | Every merge/release | Under 1 hour |

Publish actual service objectives only after restore tests prove them.

### 11.2 PostgreSQL backup policy

Use managed PostgreSQL capabilities with:

- Point-in-time recovery.
- Automated snapshots.
- Encrypted backups.
- Cross-account or cross-region copies where required.
- Retention determined by service tier and legal policy.
- Monitoring for backup freshness and failure.
- Routine restore exercises.

Logical `pg_dump` exports are useful for tenant portability and supplemental recovery, but they should not be the sole production recovery mechanism for a growing database fleet.

### 11.3 Master database criticality

The master DB maps users and tenants to their data locations. Its loss can make healthy tenant databases undiscoverable. Protect it with:

- The strongest PITR policy.
- Independent periodic catalog exports.
- Restricted administrative access.
- Audited placement changes.
- A documented catalog-reconstruction procedure.
- Recovery validation against a sample of tenant databases.

### 11.4 Tenant-specific restore

The database-per-tenant model should support restoring one tenant without rolling back others. The runbook must cover:

1. Approval and target timestamp.
2. Restore into a new database rather than overwriting the current database immediately.
3. Integrity and schema validation.
4. File/object consistency checks.
5. Controlled placement cutover.
6. Cache/pool invalidation.
7. Customer or incident communication.
8. Rollback and retention of both copies.

### 11.5 Object storage backup

- Enable versioning where required.
- Protect against bulk deletion.
- Replicate qualifying tenant data to another region/account.
- Record and monitor lifecycle rules.
- Test restoration of both object data and DB metadata.

### 11.6 Redis recovery

Treat cache entries as disposable. Configure managed Redis replication, persistence, and failover for BullMQ and other operational state. Document the expected effect of Redis loss on:

- queued jobs;
- presence;
- rate limiting;
- WebSocket delivery; and
- cached authorization context.

### 11.7 Restore drills

Automate a recurring isolated restore and validate:

- Database starts and passes integrity checks.
- Expected schema version is present.
- Tenant isolation still holds.
- Authentication and a critical read/write workflow succeed.
- Referenced objects can be downloaded.
- Recovery duration meets the target.

Track restore evidence and remediation as operational artifacts.

---

## 12. Availability and scaling

### 12.1 Scaling dimensions

Scale from measured bottlenecks:

| Component | Useful scaling signals |
|---|---|
| Web | CDN traffic and cache hit ratio |
| API | p95/p99 latency, CPU, event-loop lag, request concurrency |
| Realtime | open connections, messages/sec, memory, reconnect rate |
| Collaboration | active documents, connections, memory, persistence latency |
| Worker | queue age, depth, job duration, CPU/memory |
| PostgreSQL | CPU, IOPS, locks, connection utilization, slow queries |
| Redis | memory, operations/sec, latency, evictions, replication health |

### 12.2 Noisy-neighbor controls

Enforce tenant-aware limits for:

- API requests and expensive queries.
- Concurrent exports.
- Upload size and storage.
- Queue concurrency.
- Realtime connections and event rate.
- Meeting/call usage where applicable.
- Database statement timeout.

Move consistently heavy tenants to a high-capacity or dedicated placement tier instead of allowing them to degrade shared clusters.

### 12.3 Multi-region strategy

Do not begin with active-active multi-region writes. A safer progression is:

1. Single region with multi-zone managed services.
2. Cross-region backups and documented rebuild.
3. Warm standby for the control plane and critical shared services.
4. Region-aware tenant placement for data residency.
5. Active-active only for services and data models proven to support conflict handling.

Tenant databases can be regionally placed without making every tenant active-active.

---

## 13. Observability and service objectives

### 13.1 Telemetry

Keep Pino structured logging and add OpenTelemetry-compatible metrics and traces. Centralize:

- Application logs.
- Access logs.
- Metrics.
- Distributed traces.
- Error reporting.
- Deployment/release annotations.

### 13.2 Correlation fields

Where security and privacy policy allow, attach:

- `service`
- `environment`
- `release`
- `region`
- `request_id` / `trace_id`
- `tenant_id`
- `user_id`
- `database_cluster_id`
- `queue`
- `job_id`

Do not log secrets, tokens, password data, raw payroll/bank data, or sensitive file contents.

Avoid unrestricted tenant IDs as metric labels when tenant count becomes high. Use metrics for bounded dimensions and logs/traces for tenant-level investigation.

### 13.3 Initial service indicators

- API availability and p50/p95/p99 latency.
- HTTP error rate by route group.
- WebSocket connection success and reconnect rate.
- Realtime event delivery failures.
- Redis Pub/Sub failures and latency.
- Queue oldest-job age, throughput, retries, and failures.
- Tenant DB pool wait and saturation.
- DB query latency and lock waits by cluster.
- Migration backlog and failure count.
- Upload/finalization failures.
- Push/email delivery failure rate.
- Tenant provisioning duration.

### 13.4 Alerting

Alerts should be actionable and connected to a runbook. Prefer symptom-based alerts such as user-visible error rate, queue age, failed restore, or connection exhaustion over noisy resource thresholds alone.

---

## 14. Security and enterprise readiness

### 14.1 Identity and secrets

- Store production secrets in a managed secret manager.
- Use separate identities for API, worker, migration, and operations processes.
- Rotate signing, database, email, payment, FCM, and storage credentials.
- Prefer short-lived credentials where supported.
- Never place secrets in repository environment files or tenant records.

### 14.2 Database privilege model

- Runtime API/worker roles should not have `CREATE DATABASE` or broad cluster administration rights.
- Tenant provisioning and migration should use separate controlled roles.
- Read replicas should use read-only roles.
- Operations access should be time-bound, approved, and audited.

The current runtime ability to create tenant databases should eventually move to a privileged provisioning controller.

### 14.3 Supply chain and deployment

- Dependency and license scanning.
- Secret scanning.
- Container scanning.
- SBOM generation.
- Pinned/verified CI actions.
- Signed release artifacts and images where practical.
- Protected production environments and approval rules.
- Provenance for mobile, desktop, web, and server releases.

### 14.4 Tenant isolation verification

Every domain should have negative tests proving that one tenant cannot:

- Read another tenant's records.
- Mutate another tenant's records.
- Access another tenant's files.
- Subscribe to another tenant's realtime events.
- Guess or override database placement.
- Exhaust another tenant's quota or rate-limit bucket.

Run tenant-isolation checks in CI and include them in security review.

### 14.5 Enterprise capabilities roadmap

Depending on customer requirements:

- OIDC/SAML SSO.
- SCIM provisioning.
- Customer-managed identity provider policies.
- Data residency.
- Customer-specific retention/legal hold.
- Export and deletion workflows.
- Audit log export/SIEM integration.
- Customer-managed encryption keys for qualifying tiers.
- Formal incident response and breach notification procedures.

---

## 15. Monorepo tooling and dependency management

### 15.1 Package manager

The least disruptive initial choice is **npm workspaces**, because all projects already use npm. Define root workspaces after the application moves are planned:

```json
{
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ]
}
```

Move toward one root lockfile so dependency resolution is reproducible across applications. Native mobile constraints and Electron packaging must be validated before deleting existing lockfiles.

A future move to pnpm is possible but should be a separate ADR and migration, not combined with the folder restructure.

### 15.2 Root commands

Provide predictable root commands:

```text
npm run dev
npm run build
npm run typecheck
npm run test
npm run test:integration
npm run lint
npm run affected
```

Workspace-specific execution should remain possible.

### 15.3 Task orchestration

Start with npm workspace scripts. Add Turborepo or another task orchestrator only when dependency-aware scheduling and remote build caching have measurable value. Do not adopt Nx/Turborepo solely to obtain an `apps/` directory.

### 15.4 Versioning

- Backend/web deployables may share a release identifier while deployed independently.
- Mobile and desktop retain their own user-visible versions and release channels.
- Shared contracts need compatibility rules, not necessarily independent public package releases.
- Telemetry should always include commit SHA and deployable version.

---

## 16. CI/CD target

### 16.1 Pull-request validation

Use path-aware jobs while preserving dependency correctness:

| Change | Required validation |
|---|---|
| Shared contracts/domain | API, web, mobile, desktop consumers |
| API/database | API tests/build, migrations, integration and isolation tests |
| Realtime | WS unit/integration tests and multi-instance delivery tests |
| Web | Typecheck, Vitest, production build |
| Mobile | Typecheck, Expo config/prebuild checks where applicable |
| Desktop | Main-process typecheck and packaging smoke validation |
| Infrastructure | Format/validate/plan and security checks |

CI should include PostgreSQL and Redis integration services. Unit tests that mock the database remain useful, but they do not replace integration tests against the production database engine.

### 16.2 Build artifacts

- Build immutable deployable images/artifacts once.
- Promote the same artifact through development, staging, and production.
- Do not rebuild different source for production.
- Remove generated `server/dist` files from Git tracking after confirming build/release processes create them reliably.

### 16.3 Deployment sequence

A safe release sequence is:

1. Validate backward-compatible migration plan.
2. Build and scan immutable artifacts.
3. Deploy to staging and run contract/integration tests.
4. Run expand migrations through the migration controller.
5. Deploy canary API/realtime/worker instances.
6. Evaluate error, latency, queue, and database indicators.
7. Roll out gradually.
8. Complete data backfills asynchronously.
9. Remove old schema/behavior only in a later release.

### 16.4 Environment separation

Development, staging, and production must use separate:

- Databases and Redis deployments.
- Buckets.
- Secrets and service identities.
- Domains.
- Push/email/payment integrations where possible.
- Observability environment labels.

Production data must not be copied to lower environments without approved sanitization.

---

## 17. Infrastructure strategy

### 17.1 Near-term managed platform

A managed application platform can continue to host separate API, realtime, collaboration, worker, and migration services while WorkPulse grows. Evaluate providers against:

- Multi-replica WebSocket support.
- Private networking.
- Managed PostgreSQL PITR and read replicas.
- Managed Redis HA.
- Object storage integration.
- Regional availability and data residency.
- Autoscaling controls.
- Audit logs and access controls.
- Backup portability.
- Cost at sustained load.

Railway can remain a near-term platform, but enterprise commitments should not be made until its recovery, regional, network, and compliance capabilities match required SLAs.

### 17.2 Infrastructure as code

After selecting the target provider, manage production infrastructure with Terraform or the provider's approved equivalent. Include:

- Networks and firewall rules.
- Application services and scaling policies.
- PostgreSQL and Redis.
- Buckets and lifecycle rules.
- DNS, certificates, CDN, and WAF.
- Monitoring and alerting.
- Backup policies.
- Service identities and secret references.

Do not commit secret values or mutable production state.

### 17.3 Kubernetes adoption gate

Kubernetes should be introduced only when several of these are true:

- Many independently deployed workloads require common orchestration.
- Multi-region scheduling is needed.
- Dedicated tenant workloads are common.
- Advanced network policies or custom autoscaling are required.
- Platform portability is a contractual requirement.
- The team can operate upgrades, security, capacity, networking, and incident response.

Managed containers plus managed data services are simpler and safer before that point.

---

## 18. Phased migration roadmap

### Phase 0 — Baseline and operational safety

**Purpose:** Establish measurements and recovery before structural change.

Actions:

- Define expected tenant/user/concurrency growth for 12–24 months.
- Define provisional availability, RPO, and RTO targets.
- Create a production-like staging environment.
- Inventory databases, objects, queues, secrets, jobs, and external integrations.
- Add dashboards for API, WS, Redis, queues, DB pools, and migrations.
- Automate PostgreSQL backups and a recurring restore test.
- Confirm `server/dist` is generated in all build paths, then stop tracking it.
- Record service and domain ownership.

Exit criteria:

- Restore drill succeeds and recovery duration is recorded.
- Current production limits and connection budgets are documented.
- Critical telemetry and alerts exist.
- Staging can validate a release without production data.

### Phase 1 — Formalize the monorepo

**Purpose:** Improve repository consistency without changing runtime behavior.

Actions:

- Add npm workspaces and root scripts.
- Consolidate shared TypeScript configuration.
- Introduce workspace names.
- Move applications to `apps/` in small, separately validated changes.
- Add `packages/contracts`, `packages/config`, and `packages/test-utils` only as needed.
- Update Docker, Electron, Expo, scripts, and workflows after each move.
- Add path-aware CI for web, API, mobile, and desktop.

Exit criteria:

- One root command can typecheck/test/build supported workspaces.
- Web, server, mobile, and desktop release workflows pass from new paths.
- No server-only package can be imported into client bundles.
- Workspace dependency boundaries are documented.

### Phase 2 — Make the API horizontally scalable

**Purpose:** Allow multiple safe API replicas.

Actions:

- Move web output to static hosting/CDN.
- Introduce object storage and migrate uploads.
- Make Redis mandatory when replica count is greater than one.
- Separate cheap liveness/readiness from deep diagnostics.
- Remove correctness dependencies on process memory.
- Load-test multiple API replicas and DB connection budgets.
- Validate shared Redis rate limits and cache invalidation.

Exit criteria:

- Two or more API replicas can serve traffic without shared local disk.
- Stopping an API replica does not lose durable work.
- Upload/download behavior remains tenant-isolated.
- Database connection use stays below defined thresholds.

### Phase 3 — Extract workers and migrations

**Purpose:** Remove background and privileged work from API lifecycle.

Actions:

- Create a worker entry point and image target.
- Move BullMQ workers and schedulers out of API startup.
- Disable `setInterval` fallback in scaled production.
- Split high-cost and latency-sensitive queues where needed.
- Create a migration-controller entry point.
- Add bounded concurrency, locks, schema status, and canary migrations.
- Move tenant provisioning to a controlled privileged worker/controller.

Exit criteria:

- API startup does not run jobs or fleet migrations.
- Worker scaling can change independently.
- Duplicate schedulers cannot execute the same logical schedule incorrectly.
- Migration progress and failures are visible per tenant.

### Phase 4 — Separate realtime and collaboration

**Purpose:** Scale long-lived connections independently.

Actions:

- Add a realtime entry point and deployable.
- Validate Redis Pub/Sub delivery across several realtime replicas.
- Add reconnect-storm and connection load tests.
- Move collaboration to a separate entry point, and deployment when justified.
- Establish per-tenant connection/event limits.
- Verify rolling deployment behavior for active calls, chat, meetings, and documents.

Exit criteria:

- API scaling does not disconnect realtime users.
- Realtime replicas can be replaced without durable state loss.
- No authorization path relies on sticky sessions.
- Capacity is measurable by open connections and event rate.

### Phase 5 — Tenant database fleet and placement

**Purpose:** Scale tenants across clusters and service tiers.

Actions:

- Add database-cluster and tenant-placement models.
- Add secret references and cluster-aware connection resolution.
- Make tenant pool caching cluster-aware.
- Introduce PgBouncer/managed pooling.
- Create placement capacity policies.
- Build and test tenant relocation.
- Add shared, high-capacity, and dedicated placement tiers.
- Associate backup policy and region with placement.

Exit criteria:

- A new tenant can be placed on a selected cluster.
- An existing test tenant can be moved with validated rollback.
- No API process needs cluster-admin credentials.
- Cluster capacity and backup health are visible.

### Phase 6 — Advanced enterprise scale

**Purpose:** Add expensive capabilities only when contracts and load require them.

Potential actions:

- Multi-region tenant placement.
- Data-residency enforcement.
- Warm regional standby.
- Dedicated tenant compute pools.
- Cross-region object replication.
- Kubernetes if adoption gates are satisfied.
- Regional Redis/queue topology.

Exit criteria must be defined from the specific commercial, regulatory, and availability requirement before this phase begins.

---

## 19. Immediate 30/60/90-day priorities

### First 30 days

1. Define growth assumptions, SLOs, RPO, and RTO.
2. Establish staging and a documented release smoke test.
3. Automate DB backup freshness monitoring and one isolated restore drill.
4. Document current PostgreSQL connection budgets for API, jobs, and migrations.
5. Add liveness/readiness separation and protect detailed diagnostics.
6. Confirm/remove tracked generated `server/dist` output.
7. Add ordinary PR typechecking for mobile and desktop.

### Days 31–60

1. Introduce npm workspaces and reliable root scripts without moving every app immediately.
2. Create shared contract/config packages from proven duplication.
3. Add PostgreSQL/Redis integration tests and multi-tenant negative tests.
4. Select an object-storage provider and implement the storage abstraction.
5. Instrument queue age, DB pool waits, WS connections, and release versions.
6. Define production behavior when Redis is unavailable.

### Days 61–90

1. Put new uploads in object storage and begin legacy backfill.
2. Host the web build through static hosting/CDN.
3. Add a separate worker entry point and deployment.
4. Design and prototype the migration controller.
5. Load-test two API replicas plus Redis and tenant DB pools.
6. Draft tenant cluster/placement schema and relocation runbook.

---

## 20. Architecture decision records to create

Create ADRs before implementing the relevant phase:

1. **Keep WorkPulse as a monorepo.**
2. **Use npm workspaces and a consolidated lockfile.**
3. **Use a modular monolith before domain microservices.**
4. **Separate API, realtime, collaboration, worker, and migration deployables.**
5. **Retain database-per-tenant with cluster-aware placement.**
6. **Use object storage instead of application volumes.**
7. **Require Redis for horizontally scaled production.**
8. **Run migrations outside API startup.**
9. **Select production provider and infrastructure-as-code tooling.**
10. **Define backup, restore, retention, and data-residency policies.**

Each ADR should record context, decision, alternatives, consequences, migration approach, and rollback considerations.

---

## 21. Anti-patterns to avoid

- Splitting repositories to solve deployment scaling.
- Creating one microservice per database table or route group.
- Moving all folders and changing package managers in one pull request.
- Letting every API replica run scheduled fallback timers.
- Giving normal API processes cluster-admin database privileges.
- Running all tenant migrations as an unbounded startup sweep.
- Querying every tenant database in synchronous user requests.
- Using tenant IDs supplied by the client as the authorization boundary.
- Storing production uploads on instance-local disks.
- Treating a snapshot as a backup without a tested restore.
- Adding Kubernetes without staffing and operational ownership.
- Sharing UI code across web and native when it creates more conditionals than reuse.
- Adding generic packages that become unowned dependency dumping grounds.

---

## 22. Major risks and mitigations

| Risk | Mitigation |
|---|---|
| Large repository move breaks builds/releases | Move one app at a time; validate all scripts and workflows after each move |
| Shared contracts tightly couple clients to backend internals | Share stable DTOs/schemas only; enforce package export boundaries |
| API replicas exhaust tenant DB connections | Cluster-aware small pools, pooler, global budgets, pool wait alerts |
| Redis outage causes duplicate work | Make Redis required in scaled production; idempotent jobs; explicit degraded mode |
| Tenant migration fleet becomes slow | Bounded concurrency, canaries, resumability, schema compatibility |
| Object migration loses files | Dual-read/backfill, checksums, count validation, rollback retention |
| Realtime extraction causes delivery gaps | Multi-instance integration/load tests; Redis fan-out; reconnect recovery |
| Master DB outage hides tenant data | Strong PITR, independent catalog exports, tested reconstruction |
| Dedicated tenants create operational variants | Placement policies, same application artifact, infrastructure automation |
| Too much platform work slows product delivery | Phase by measured risk/load; define exit criteria and stop points |

---

## 23. Success criteria

The restructuring is successful when:

- Web, mobile, desktop, API, realtime, collaboration, and workers remain coordinated in one understandable monorepo.
- Each deployable can be built, tested, deployed, rolled back, and scaled independently.
- API replicas are stateless and do not depend on local uploads or local schedules.
- Production Redis failure behavior is explicit and safe.
- Tenant databases can be placed across multiple clusters without application code forks.
- Large tenants can move to dedicated capacity.
- Database and object backups are routinely restored and verified.
- Tenant isolation is continuously tested across HTTP, realtime, database, queue, and file access.
- Operators can identify the affected service, release, cluster, tenant, and dependency during an incident.
- Infrastructure complexity grows only when supported by measured demand or contractual requirements.

---

## 24. Final recommendation

Keep WorkPulse in a monorepo and formalize it. The highest-value changes are not an immediate folder rename or a microservice rewrite. They are:

1. Establish recovery, staging, and observability.
2. Formalize workspace tooling and CI.
3. Move static assets and uploads out of the API runtime.
4. Make scaled production explicitly dependent on managed Redis.
5. Extract workers and migrations from API startup.
6. Separate realtime/collaboration when connection load warrants it.
7. Add cluster-aware tenant placement and connection pooling.

This path preserves current product velocity while building the operational boundaries needed for an enterprise-grade, multi-tenant WorkPulse platform.

---

## 25. Incremental implementation task backlog

This section translates the preceding roadmap into small, dependency-ordered tasks that can be implemented and reverted independently. It reflects the current repository state and assumes that no customer tenants have been onboarded yet.

The absence of customer tenant data provides an opportunity to establish storage, migration, provisioning, and placement boundaries before compatibility with existing customer deployments becomes a constraint. It does not remove the need for staged changes, synthetic tenant data, rollback paths, and isolation tests.

### 25.1 Current implementation constraints

The task ordering below accounts for the following current conditions:

- The root `package.json` identifies a monorepo but does not define npm workspaces.
- `client`, `server`, `mobile`, and `desktop` have separate npm lockfiles.
- Docker, CI, release workflows, desktop packaging, mobile asset generation, and local scripts contain paths tied to the current top-level directories.
- The desktop application directly invokes the web build from `../client`.
- The current backend process owns HTTP APIs, WebSockets, collaboration, workers, scheduled jobs, migrations, web static files, and local uploads.
- Production startup runs migrations before starting the server.
- The job scheduler can fall back to process-local `setInterval` timers when Redis is unavailable.
- Production uploads currently depend on `server/uploads` and an application volume.
- Generated `server/dist` output is ignored by pattern but is still tracked in Git.
- Ordinary pull-request CI validates server and web but not mobile and desktop typechecking.
- The current project policy requiring Redis/BullMQ in-memory fallback conflicts with the target requirement that Redis be mandatory for multi-replica production. This must be resolved explicitly before changing production fallback behavior.

### 25.2 Safety rules for every restructuring change

Every restructuring pull request should follow these rules:

1. Change one structural concern at a time.
2. Record the relevant validation result before making the change.
3. Make the smallest change that establishes the intended boundary.
4. Run the same validation after the change.
5. Do not combine database schema changes and directory moves.
6. Do not combine package-manager changes and directory moves.
7. Preserve existing runtime behavior unless the pull request explicitly introduces and tests a replacement.
8. Use `git mv` for directory moves so history remains discoverable.
9. Do not delete an old execution path until its replacement passes locally, in CI, and in staging.
10. Keep every pull request independently revertible.
11. Use synthetic tenants with overlapping record identifiers to validate isolation.
12. Update Docker, scripts, workflows, documentation, and release paths in the same pull request as the specific path they reference.

### 25.3 Stage A — Establish a trustworthy baseline

#### T001 — Preserve this architecture plan

Commit this document in a documentation-only pull request before combining it with implementation changes. Keep its status as proposed until the relevant exit criteria are met.

**Done when:**

- The plan is version-controlled.
- The pull request contains no application or runtime changes.

#### T002 — Capture the current validation baseline

Run and record the existing server, web, mobile, desktop, and Docker validations:

```powershell
npm --prefix server run typecheck
npm --prefix server run build
npm --prefix server test

npm --prefix client run typecheck
npm --prefix client test
npm --prefix client run build

npm --prefix desktop run typecheck

Set-Location mobile
npx tsc --noEmit
Set-Location ..

docker build -t workpulse:baseline .
```

Record test counts, build durations, warnings, Docker startup results, and any known failures separately from restructuring work.

**Done when:**

- The current branch has a reproducible validation baseline.
- Existing failures cannot be incorrectly attributed to a later restructuring task.

#### T003 — Add a documented release smoke-test checklist

Create `docs/runbooks/release-smoke-test.md` covering:

- Liveness and readiness.
- Web load and authentication.
- Authenticated tenant resolution.
- Cross-tenant rejection using two synthetic tenants.
- A representative REST read and write.
- WebSocket connection, delivery, and reconnect.
- Collaboration document open and edit.
- Background job execution.
- Upload and authenticated download.
- Desktop renderer loading.
- Mobile API and WebSocket connectivity.

**Depends on:** T002.

**Done when:** every structural pull request can execute the same smoke test and attach pass/fail evidence.

#### T004 — Record growth, recovery, and resource assumptions

Document provisional 12- and 24-month tenant, user, concurrency, WebSocket, storage, availability, RPO, RTO, deployment-interruption, and PostgreSQL connection targets. Calculate the connection budget using replica count, active tenant pools, pool size, master pools, workers, and migration connections.

**Done when:** the team can determine numerically whether adding an API or worker replica stays within the database connection budget.

#### T005 — Define staging data and complete a restore drill

Create a production-like staging dataset containing a master catalog, two synthetic tenant databases, deliberately overlapping identifiers, test objects, queue jobs, and realtime users. Back up and restore the master database and one tenant database into isolated destinations, then run schema, login, tenant-isolation, and smoke checks.

**Depends on:** T004.

**Done when:** both database types can be restored without production data, the procedure cannot overwrite its source, and the measured restore duration is recorded.

### 25.4 Stage B — Improve safety without changing repository layout

#### T006 — Add a mobile typecheck script

Add a non-mutating `typecheck` script to `mobile/package.json` using the currently supported Expo TypeScript configuration. Do not upgrade Expo or regenerate native projects in this task.

**Depends on:** T002.

**Done when:** `npm --prefix mobile run typecheck` passes.

#### T007 — Add mobile and desktop typechecking to pull-request CI

Add separate mobile and desktop typecheck jobs to `.github/workflows/ci.yml`. Keep installer packaging in the release workflows rather than ordinary pull-request CI.

**Depends on:** T006.

**Done when:** mobile and desktop TypeScript errors block a pull request without changing existing web/server checks.

#### T008 — Stop tracking generated server output

Confirm that clean server, Docker, and deployment builds regenerate every required file, then remove `server/dist` from Git tracking. Do not remove source files or the build step.

**Depends on:** T002 and a green CI baseline.

**Done when:** `git ls-files "server/dist/**"` returns no files while clean server and Docker builds pass.

#### T009 — Separate liveness, readiness, and diagnostics

Provide a cheap liveness endpoint, a bounded readiness endpoint for required local dependencies, and an authenticated operational diagnostics endpoint. Load-balancer probes must never iterate all tenant databases.

**Depends on:** T002.

**Done when:** probes are cheap and bounded, dependency failures affect readiness correctly, detailed diagnostics require authorization, and no secret or reusable connection value is exposed.

#### T010 — Inventory runtime responsibilities and ownership

Document the current and future owner of REST routes, WebSockets, collaboration, jobs, migrations, upload handling, web static files, and tenant provisioning. Include environment variables, database privileges, Redis use, endpoints, shutdown behavior, tests, and deployment dependencies.

**Done when:** every responsibility has one proposed process owner and shared source code is distinguished from executable entry points.

### 25.5 Stage C — Formalize the monorepo before moving applications

#### T011 — Add root proxy commands without enabling workspaces

Add predictable root scripts using `npm --prefix` for server, web, mobile, and desktop typechecking and for currently supported tests and builds. Root `build` should not package mobile or desktop installers.

**Depends on:** T002 and T006.

**Done when:** root `typecheck`, `test`, and `build` commands reproduce the existing package-level validations without changing dependency resolution.

#### T012 — Record the npm-workspaces ADR

Decide to use npm workspaces initially, preserve native mobile and Electron constraints, consolidate lockfiles separately, avoid Turborepo until justified, and avoid directory moves in the workspace-conversion change. Explicitly reject combining workspace adoption, folder movement, package-manager replacement, and dependency upgrades.

**Depends on:** T011.

**Done when:** migration, validation, and rollback steps are documented.

#### T013 — Assign scoped and unique workspace names

Rename only package identities:

```text
client   -> @workpulse/web
server   -> @workpulse/backend
mobile   -> @workpulse/mobile
desktop  -> @workpulse/desktop
```

Use `@workpulse/backend` until API, realtime, collaboration, worker, and migration entry points are separated; naming the current combined process `api` would misrepresent its responsibilities.

**Depends on:** T012.

**Done when:** package names are unique and all existing builds and release behavior remain unchanged.

#### T014 — Enable npm workspaces at the current paths

Initially configure workspaces as `client`, `server`, `mobile`, and `desktop`. Do not introduce `apps/*` yet. Validate root installation, mobile patches, Expo resolution, server Jest and TypeScript, Vite and Vitest, desktop TypeScript, Docker, and the desktop-compatible web build from a clean checkout.

**Depends on:** T013.

**Done when:** root workspace commands and package-local commands both work without moving directories or intentionally changing dependency versions.

#### T015 — Consolidate lockfiles separately

Create one root npm lockfile only after workspace installation is stable. Validate React version boundaries, Expo peer dependencies, native modules, `patch-package`, Electron, `sharp`, Firebase, Notifee, production Docker installation, and desktop packaging. Do not upgrade dependencies to remove unrelated warnings.

**Depends on:** T014.

**Done when:** clean root `npm ci`, all baseline checks, mobile patching, Docker production installation, and desktop dependency resolution pass. If native constraints prevent safe consolidation, retain separate lockfiles temporarily and document the exception.

#### T016 — Add conservative shared TypeScript bases

Share only proven common compiler settings. Retain distinct browser bundler, Node emission, Electron NodeNext, and Expo configurations. Mobile should continue extending Expo's supported base unless a verified alternative exists.

**Depends on:** T014.

**Done when:** all four typechecks pass and emitted JavaScript remains compatible.

#### T017 — Document and enforce package boundaries

Prevent client applications from importing server-only code; prevent contract packages from importing Express, PostgreSQL, filesystem, or UI frameworks; require public package exports; and disallow deep imports into package internals. Start with documentation or a focused CI check rather than adding a large orchestration framework.

**Depends on:** T014.

**Done when:** prohibited client-to-server imports fail validation and every shared package has an explicit responsibility.

### 25.6 Stage D — Establish integration and tenant-isolation tests

#### T018 — Add PostgreSQL and Redis integration services to CI

Add a separate integration job using the same supported PostgreSQL and Redis major versions as the deployment environment. Test master initialization, tenant initialization, versioned migrations, queues, Pub/Sub, and distributed rate limits against real services.

**Depends on:** T007 and T014.

**Done when:** real-engine integration failures are visible separately from mocked unit-test failures.

#### T019 — Create reusable two-tenant fixtures

Create and clean up two synthetic tenant databases with overlapping user, task, conversation, and file identifiers.

**Depends on:** T018.

**Done when:** tests can prove that authenticated tenant placement, rather than a globally unique record ID assumption, controls access.

#### T020 — Add negative isolation tests for every boundary

Add independent suites for HTTP reads, HTTP writes, files, WebSocket subscriptions and events, collaboration documents, queue jobs, rate-limit keys, and database-placement override attempts.

**Depends on:** T019.

**Done when:** Tenant A cannot read, mutate, subscribe to, process, or download Tenant B data, and client-supplied tenant/database values cannot override server-derived context.

### 25.7 Stage E — Remove production file-storage coupling

#### T021 — Record object-storage design and add a provider-neutral interface

Define tenant-scoped put, read, delete, existence/metadata, signed authorization, and object-key operations. The server must generate tenant and organization key prefixes from authenticated context.

**Depends on:** T020.

**Done when:** routes can depend on a storage interface while a local filesystem adapter preserves current behavior.

#### T022 — Route local uploads through the storage interface

Migrate direct filesystem access one category at a time: avatars, chat attachments, task/note assets, and generated exports. Continue using local storage behind the interface during this step.

**Depends on:** T021.

**Done when:** upload behavior and isolation tests pass and direct filesystem access is localized in the adapter.

#### T023 — Store new production uploads in object storage

Add private object storage with authenticated or signed delivery, size and content-type limits, checksums, failed-upload cleanup, tenant deletion behavior, and a malware-scanning integration point. Because there are no customer uploads, a production legacy backfill should not be required, but the migration procedure should still be tested with synthetic files.

**Depends on:** T022 and an object-storage provider decision.

**Done when:** new production uploads do not depend on `server/uploads` and cross-tenant object access fails.

#### T024 — Remove the production upload-volume dependency

Update Docker, Compose, the entrypoint, deployment configuration, and documentation. A local-development filesystem adapter may remain.

**Depends on:** T023.

**Done when:** production starts without mounting `server/uploads` and upload/download tests pass across at least two API instances.

### 25.8 Stage F — Extract execution boundaries without domain microservices

#### T025 — Separate application construction from process startup

Separate Express application creation, dependency initialization, HTTP server creation, signal handlers, and `listen()`. Importing the application for tests must not start listeners, jobs, WebSockets, migrations, or process exits.

**Depends on:** T020.

**Done when:** REST tests construct the application deterministically while the existing combined runtime remains available.

#### T026 — Add an explicit worker entry point

Create a worker entry point for the current job initialization. Keep the old server-startup option behind configuration during staging rollout, then disable jobs in the API only after the worker is proven.

**Depends on:** T025.

**Done when:** API and worker start independently and multiple workers cannot incorrectly duplicate one logical schedule.

#### T027 — Resolve Redis fallback behavior by topology

Update the relevant ADR and project policy so local single-node development may use an explicitly configured fallback, while multi-replica production requires Redis and fails safely instead of creating independent timers, rate limiters, or presence state.

**Depends on:** T026.

**Done when:** policy and implementation agree, production cannot silently create duplicate fallback schedules, and Redis degradation behavior is tested.

#### T028 — Strengthen the migration runner

Add a global lock, bounded tenant concurrency, non-zero failure exit, per-tenant duration and status, resumable retries, schema-version reporting, dry-run/status commands, canary selection, and pause/cancellation between tenants. Validate using synthetic tenant databases.

**Depends on:** T019.

**Done when:** duplicate controllers are prevented, any tenant failure is visible and fails the operation, and resume does not reapply already successful migrations unnecessarily.

#### T029 — Remove migrations from API startup

Change release orchestration from `node migrate.js && node index.js` to a separately controlled migration operation followed by API deployment. Roll out in staging before production.

**Depends on:** T028.

**Done when:** API startup never sweeps tenant databases, rolling API restarts do not rerun migrations, and migration failure blocks promotion rather than application replica startup.

#### T030 — Separate privileged tenant provisioning

Move `CREATE DATABASE`, `DROP DATABASE`, and cluster-administration operations to a controlled provisioning or migration process. The API should request or enqueue provisioning and activate a tenant only after schema validation.

**Depends on:** T028.

**Done when:** normal API credentials cannot create or drop databases and all provisioning operations are audited.

### 25.9 Stage G — Establish cluster-aware tenancy before onboarding

#### T031 — Record the tenant-placement schema ADR

Define database clusters, tenant placements, status, tier, region/residency, schema version, migration state, backup-policy reference, and secret reference. Do not store reusable plaintext connection URLs in tenant catalog rows.

**Depends on:** T004 and T019.

#### T032 — Add placement tables additively

Add control-plane placement tables while preserving the current `db_name` and `db_host` resolution. Register a default cluster representing the existing development/staging PostgreSQL environment.

**Depends on:** T031.

**Done when:** current tenant access still works and the new model can represent the current deployment.

#### T033 — Dual-write tenant creation to placement records

Create a placement record during synthetic tenant provisioning, validate the schema, and activate the tenant only after successful validation. Keep legacy fields temporarily.

**Depends on:** T032.

**Done when:** every newly created test tenant has exactly one active placement and failed provisioning cannot leave a falsely active tenant.

#### T034 — Resolve connections from placement data

Use server-derived tenant identity to resolve cluster and database placement. Never accept a client-supplied cluster, database name, host, or credential reference. Keep a temporary compatibility fallback during rollout and make pool cache keys placement-aware.

**Depends on:** T033 and T020.

**Done when:** synthetic tenants can be placed on different test clusters/endpoints and placement override attempts fail.

#### T035 — Remove the legacy placement fallback before onboarding

After synthetic and staging validation, remove legacy routing fields and logic through an expand/contract migration.

**Depends on:** T034.

**Done when:** placement records are the only database-routing source, provisioning/deletion use them, and API processes hold no cluster-admin credentials.

### 25.10 Stage H — Move one application directory at a time

Directory moves begin only after root commands, workspaces, CI, and package boundaries are reliable. The recommended order is:

1. `client` to `apps/web`.
2. `desktop` to `apps/desktop`.
3. `mobile` to `apps/mobile`.
4. `server` to `apps/backend`.
5. Rename or split backend deployables only after their entry points are independent.

The current server should not move directly to `apps/api`, because it still owns more than the stateless HTTP API.

#### T036 — Move the web application only

Update its workspace path, Docker paths, CI, desktop build invocation, desktop release artifacts, local scripts, generators, and directly affected documentation in the same pull request.

**Depends on:** T017.

**Done when:** web typecheck/test/build, server validation, Docker build, desktop typecheck, and the Electron-compatible web build all pass.

#### T037 — Move the desktop application only

Update the desktop release workflow, release scripts, Electron builder paths, mobile icon-source references, and documentation. Run a packaging smoke check on the primary supported operating system.

**Depends on:** T036.

#### T038 — Move the mobile application only

Update the mobile release workflow, native-change detection, Gradle caches, repository-root calculations, icon-source paths, Expo configuration references, and version/release scripts. Do not reorganize the internal Expo Router, `src`, or native-module structure in this task.

**Depends on:** T037.

**Done when:** mobile typecheck, Expo configuration generation, native reference checks, patch application, and release workflow validation pass.

#### T039 — Move the combined backend only

Update Docker, Compose, entrypoint assumptions, CI, local startup scripts, deployment documentation, environment discovery, storage-adapter paths, and any remaining static web paths.

**Depends on:** T038 and completion of the relevant worker/migration boundaries.

**Done when:** server unit/integration tests, Docker build/startup, migration controller, worker entry point, and release smoke tests pass from the new path.

### 25.11 Recommended first implementation sequence

Start with the following order:

```text
T001  Commit the architecture plan separately
T002  Establish the validation baseline
T003  Add the release smoke-test runbook
T006  Add the mobile typecheck command
T007  Add mobile and desktop pull-request typechecking
T008  Remove tracked server/dist output
T009  Separate health endpoints
T010  Inventory runtime ownership
T011  Add root proxy commands
T012  Record the npm-workspaces ADR
T013  Assign scoped package names
T014  Enable workspaces at the current paths
```

The first code pull request should be limited to T006 after T002 confirms or documents the current baseline. T007 should then be a separate CI-only pull request. Workspaces, lockfile consolidation, dependency upgrades, and directory moves must not be included in either change.

### 25.12 Minimum readiness gate before the first customer tenant

Before onboarding a customer tenant, complete at least the following capabilities even if all directory moves are not finished:

- A tested master-database and tenant-database restore procedure.
- Production-like staging with repeatable release smoke tests.
- Two-tenant integration fixtures and negative isolation tests.
- Private object storage for production uploads.
- A migration controller outside API startup.
- Safe, explicit Redis behavior with no duplicate production timer fallback.
- Cluster and tenant-placement records as the database-routing source.
- API credentials without database creation or deletion privileges.
- Cheap liveness/readiness probes and protected diagnostics.
- Audited tenant provisioning that activates a tenant only after schema validation.

These operational and data boundaries provide more protection to the first tenant than completing the visual move to an `apps/` directory. Repository moves should continue incrementally after these controls are reliable.
