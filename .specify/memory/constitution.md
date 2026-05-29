<!--
SYNC IMPACT REPORT
==================
Version change: (none) → 1.0.0
Constitution created from scratch by inspecting the WorkPulse codebase.

Added sections:
- Core Principles (6 principles derived from codebase patterns and ADRs)
- Technology Stack Constraints
- Development Workflow
- Governance

Templates requiring updates:
- .specify/templates/plan-template.md ✅ Constitution Check gates align with principles
- .specify/templates/spec-template.md ✅ No structural changes required
- .specify/templates/tasks-template.md ✅ Task phases reflect principle-driven categories

Follow-up TODOs:
- TODO(RATIFICATION_DATE): Confirm exact project start date; using 2026-05-20 (earliest ADR date)
-->

# WorkPulse Constitution

## Core Principles

### I. Multi-Tenancy Isolation (NON-NEGOTIABLE)

Every feature, data query, API endpoint, and WebSocket event MUST be scoped to the
authenticated tenant. Requirements:

- All database queries MUST include a `tenant_id` (or equivalent org/user scope) filter.
- Server-side middleware (`auth.js`, `rbac.js`) MUST validate tenant membership before
  any data access; no client-supplied tenant ID may override the session-derived value.
- Cross-tenant data access is forbidden by default; any intentional exception requires
  an explicit ADR and MUST be gated by `platform_admin` role only.
- New routes MUST pass a tenant-isolation review before merging.

**Rationale**: WorkPulse is a multi-tenant SaaS platform. A single cross-tenant data
leak constitutes a critical security incident. Isolation enforced in middleware is the
only acceptable boundary.

### II. Security-First at Every Layer

Authentication and authorisation are enforced server-side; client-side role checks are
cosmetic only. Requirements:

- JWT MUST be stored in HttpOnly cookies; never in `localStorage` or `sessionStorage`.
- RBAC MUST be applied in server middleware for every protected route; UI-only guards
  are insufficient.
- Rate limiting MUST be applied at all public API boundaries (auth, invite, reset).
- Passwords MUST be hashed with bcryptjs (≥ 12 rounds); plaintext passwords MUST never
  be logged or stored.
- File uploads MUST be served through authenticated static middleware; no publicly
  accessible upload paths.
- All user-facing input MUST be validated and sanitised before reaching the database or
  being broadcast over WebSocket.

**Rationale**: The OWASP Top 10 defines the minimum security bar. WorkPulse handles
employee PII, attendance records, and private communications; a breach has legal and
reputational consequences.

### III. Real-Time Reliability & Idempotency

WebSocket handlers, presence state machines, and call/meeting signalling MUST be
designed for reconnect safety. Requirements:

- All WS message handlers MUST be idempotent: receiving the same message twice MUST
  produce the same final state.
- Presence, call status, and meeting state MUST flow through single-responsibility
  services (e.g., `StatusService`); multiple uncoordinated writers to the same column
  are forbidden (see ADR-0001).
- Re-joining a room or reconnecting a WebSocket MUST NOT duplicate state entries
  (sessions, participants, etc.).
- Any stateful transition (connect, disconnect, join, leave, status change) MUST be
  persisted to an audit table.

**Rationale**: Network flaps and browser reloads are routine. Non-idempotent handlers
produce ghost state that is impossible to diagnose in production (documented in
ADR-0001 with 14 reproducible bugs).

### IV. Test Coverage for Critical Paths

Server-side business logic and API contracts MUST have automated test coverage.
Requirements:

- New API routes MUST have at least one integration test (Jest + Supertest) covering the
  happy path and primary error case before merging.
- Stateful services (auth, status, billing, leave approval) MUST have unit tests for
  each state transition.
- Client components that own user-facing data mutation MUST have a Vitest + React
  Testing Library test for the primary interaction.
- Test files MUST live alongside the code they test (`__tests__/` adjacent directories).
- Tests MUST run in CI and block merges on failure; skipping tests requires a written
  justification in the PR.

**Rationale**: WorkPulse has 20 server test suites reflecting hard-won coverage of
complex business rules (leave accrual, sprint rollover, payroll export). Regressions in
these areas are expensive to discover in production.

### V. Observability & Structured Logging

All server-side code MUST use structured logging; silent failures are forbidden.
Requirements:

- Use Pino (`utils/logger.js`) for all server-side logging; `console.log` in production
  paths MUST be replaced with appropriate Pino log levels.
- Every significant domain event (clock-in, status change, task state transition, call
  start/end, leave approval) MUST emit a structured log entry and, where appropriate, an
  audit row.
- Errors MUST be logged with stack traces and contextual fields (tenant_id, user_id,
  route); never swallowed silently.
- WebSocket handler lifecycle (connect, message received, error, disconnect) MUST be
  observable via log output (see ADR-005).

**Rationale**: Distributed real-time systems fail in subtle ways. Structured logs enable
rapid root-cause analysis without source-code spelunking.

### VI. Simplicity & Incremental Complexity

Prefer the simplest solution that satisfies the requirement. Requirements:

- Redis and BullMQ are optional infrastructure; server code MUST degrade gracefully to
  in-memory fallbacks when Redis is unavailable.
- Feature flags MUST default to `false` (disabled) for new tenants; opt-in, not opt-out.
- Do not introduce a new abstraction layer unless it is used by at least two independent
  callers; one-off helpers belong inline.
- Refactors unrelated to the current feature are forbidden in the same PR; open a
  separate ADR-backed task.
- YAGNI: do not implement speculative generality; if a requirement is not in the current
  spec, it MUST NOT be built.

**Rationale**: WorkPulse already spans 17 API routes, 20 test suites, WebRTC, BullMQ,
Redis, and a desktop Electron shell. Accidental complexity compounds quickly. Every line
of code is a maintenance liability.

## Technology Stack Constraints

The following stack decisions are locked and MUST NOT be changed without an ADR and
constitution amendment:

| Layer | Locked Choice |
|---|---|
| Frontend framework | React 18 + Vite 7 + React Router v6 |
| Styling | CSS Modules + global CSS variables; no CSS-in-JS, no SCSS |
| Backend framework | Node.js + Express 5 |
| Primary database | PostgreSQL (pg pool) |
| Cache / queue broker | Redis (ioredis) — optional, graceful fallback required |
| Real-time transport | Native `ws` WebSocket library; no Socket.io |
| Auth token storage | HttpOnly cookies (JWT); no localStorage |
| Structured logging | Pino |
| Server testing | Jest + Supertest |
| Client testing | Vitest + React Testing Library |
| Containerisation | Docker + docker-compose; production on Railway |
| Desktop shell | Electron (desktop/ directory) |

New dependencies MUST be justified in the PR description with: purpose, bundle-size
impact (client), and maintenance health (last release, open issues).

## Development Workflow

- **Branching**: Feature branches named `###-short-description` from `master`.
- **Specs first**: Non-trivial features MUST have a spec (`/speckit.specify`) before
  implementation begins. Specs live in `specs/###-feature-name/spec.md`.
- **ADRs**: Architectural decisions that affect the stack, data model, or a core
  principle MUST be documented as an ADR in `docs/adr/`.
- **No direct pushes to `master`**: All changes via pull request; at least one reviewer.
- **Migration discipline**: Database schema changes MUST be additive where possible;
  destructive migrations require a rollback plan in the PR.
- **Environment parity**: Local development MUST use Docker Compose to match production
  Postgres and Redis versions. SQLite or in-memory substitutes are not acceptable for
  integration tests.
- **Secrets management**: No secrets, API keys, or credentials in source code or commit
  history; use environment variables loaded from `.env` (gitignored).

## Governance

This constitution supersedes all local conventions, README guidance, and informal
agreements when a conflict exists. Amendments require:

1. A written proposal (PR description or ADR) explaining the rationale.
2. Review and approval by at least one other engineer with context of the affected area.
3. `CONSTITUTION_VERSION` increment following semantic versioning (MAJOR for principle
   removal/redefinition, MINOR for new principle/section, PATCH for clarifications).
4. `LAST_AMENDED_DATE` updated to the merge date.

All PRs and code reviews MUST verify compliance with the principles above. Complexity
additions MUST be justified against Principle VI. Use `ARCHITECTURE.md` for runtime
development guidance on the full module map.

**Version**: 1.0.0 | **Ratified**: 2026-05-20 | **Last Amended**: 2026-05-29
