# WorkPulse — Enterprise Readiness Roadmap

---

## TIER 1 — Critical Blockers (Must-Have)

### 1. Database: SQLite → PostgreSQL
SQLite with WAL mode hits a hard wall at ~50 concurrent users. PostgreSQL enables row-level locking, connection pooling (pg-pool), and horizontal scaling.
- [ ] Replace `better-sqlite3` with `pg` / `postgres.js`
- [ ] Migrate schema (all tables, indexes, constraints)
- [ ] Update all query syntax (parameterized `$1, $2` style)
- [ ] Add connection pool config (`max`, `idleTimeoutMillis`)
- [ ] Update Docker Compose to include a `postgres` service
- [ ] Set up database URL via environment variable

### 2. Email Notification System
Currently **0% implemented** — the biggest functional gap.
- [ ] Integrate email provider (Nodemailer + SMTP or SendGrid or AWS SES)
- [ ] Leave approved / rejected → email to requester
- [ ] Manual entry approved / rejected → email to requester
- [ ] Task assigned to a user → email notification
- [ ] Daily attendance summary email to managers
- [ ] Password reset confirmation email
- [ ] Welcome email on account creation
- [ ] Email template system (HTML + plain-text fallback)
- [ ] Unsubscribe / notification preference settings per user

### 3. In-App Notification Center
The notifications API route exists but the UI is incomplete.
- [ ] Real-time delivery via WebSocket (Socket.io) or Server-Sent Events
- [ ] Notification feed / bell dropdown in Navbar
- [ ] Notification types: approvals, task assignments, @mentions, leave decisions
- [ ] Mark as read / Mark all as read
- [ ] Notification preferences per user (in-app, email, both, none)
- [ ] Persist notifications in DB with `read` flag and timestamp
- [ ] Badge count on Navbar bell icon

### 4. SSO / OAuth2 Integration
Enterprise companies use Google Workspace, Microsoft Azure AD, or Okta.
- [ ] Google OAuth2 (most common for SMEs)
- [ ] Microsoft Azure AD / SAML (large enterprises)
- [ ] LDAP sync for on-premise corporate directories
- [ ] Auto-provision user account on first SSO login
- [ ] Map SSO group → WorkPulse role
- [ ] Allow mixed auth (local accounts + SSO in same org)

### 5. HTTPS Enforcement + Secret Management
- [ ] Enforce `Secure` + `SameSite=Strict` cookie flags in all environments
- [ ] JWT secret rotation with grace period
- [ ] Move secrets to environment-based management (AWS Secrets Manager, HashiCorp Vault, or Docker secrets)
- [ ] Remove `.env` with secrets from version control (`.gitignore` enforcement)
- [ ] HSTS header configuration in Nginx

---

## TIER 2 — High Value (Next Sprint)

### 6. Two-Factor Authentication (2FA)
- [ ] TOTP-based 2FA (Google Authenticator / Authy compatible)
- [ ] QR code enrolment flow in profile settings
- [ ] Backup / recovery codes generation
- [ ] SMS fallback (Twilio or AWS SNS)
- [ ] Enforce 2FA mandatory for `hr_admin` and `super_admin` roles
- [ ] Grace period: allow 2FA enrolment within N days before enforcement

### 7. Reporting & Exports
Currently no export functionality exists anywhere.
- [ ] Attendance report (date range, by user / team) → CSV + PDF
- [ ] Leave summary (monthly / annual per user) → CSV + PDF
- [ ] Payroll-ready hours sheet (floor time + overtime) → CSV
- [ ] Audit log export → CSV
- [ ] Team productivity report (hours, tasks done, punctuality) → PDF
- [ ] Scheduled reports (auto-email monthly summary to managers)
- [ ] Report builder UI (select columns, date range, filter by team/dept)

### 8. Payroll Integration
Time tracking and leave data is payroll-ready but has no output connector.
- [ ] Overtime calculation and flagging per pay period
- [ ] Export in payroll-compatible formats (Gusto, QuickBooks, Zoho Payroll CSV)
- [ ] Comp-off / compensatory leave from approved overtime
- [ ] Pay period configuration (weekly, bi-weekly, monthly)
- [ ] Lock period: prevent editing entries after payroll cutoff date

### 9. Shift & Schedule Management
Currently only a single work schedule per org is supported.
- [ ] Multiple shift patterns (morning / evening / night)
- [ ] Rotational shift assignments per user
- [ ] Weekly/monthly roster publishing by managers
- [ ] Overtime rules per shift type
- [ ] Grace period for clock-in (configurable late tolerance, e.g. 10 min)
- [ ] Shift swap requests between employees
- [ ] Shift schedule visible on Dashboard and Manager view

### 10. Full-Text Search
No search exists anywhere in the application.
- [ ] Global search bar (tasks, notes, users, audit logs)
- [ ] Task search across sprints and backlog
- [ ] Audit log search by actor, action, entity, date range
- [ ] Notes full-text search across all pages
- [ ] SQLite FTS5 virtual tables (or Postgres full-text search)
- [ ] Search results page with type filters

---

## TIER 3 — Feature Completeness

### 11. Performance Reviews & 1-on-1s
Managers have attendance and task data but no structured review process.
- [ ] Goal setting per user (OKRs or KPIs) linked to sprints
- [ ] Quarterly / annual performance rating by manager
- [ ] Self-assessment form for employees
- [ ] 1-on-1 meeting notes (private, manager-visible only)
- [ ] Peer feedback collection (360° review)
- [ ] Performance history timeline per employee
- [ ] Review cycle configuration (org-wide cadence)

### 12. Onboarding Workflow
No guided setup when a new account is created.
- [ ] Welcome email with getting-started checklist
- [ ] First-login wizard (set email, timezone, avatar, manager)
- [ ] Invite-code-based self-registration with org pre-assignment
- [ ] Onboarding checklist page (visible until completed)
- [ ] Admin onboarding tracker (see which new users haven't completed setup)
- [ ] Bulk CSV import for users (name, email, role, department, team)

### 13. Webhook / Integration Layer
- [ ] Outbound webhook config UI (URL, secret, event selection)
- [ ] Slack integration: leave approvals, daily stand-up summary, late clock-in alerts
- [ ] Microsoft Teams integration (same events as Slack)
- [ ] Google Calendar sync: approved leave dates → user's calendar
- [ ] Outlook Calendar sync
- [ ] Zapier / Make.com compatible webhook endpoint
- [ ] Jira / Linear task sync (bidirectional — optional)

### 14. Advanced Leave Features
- [ ] Compensatory leave (comp-off): auto-generate leave credit for approved overtime
- [ ] Leave encashment rules (carry-forward → cash payout)
- [ ] Probation period restrictions (configurable: no leave in first N days)
- [ ] Multi-step leave approval chain (team lead → manager → HR)
- [ ] Leave blackout dates (e.g., quarter-end, product launch windows)
- [ ] Leave calendar view (team-wide absence overview)
- [ ] Negative balance allowed flag per leave type
- [ ] Weekend / holiday exclusion in leave day counting (already partial)

### 15. Organization Hierarchy Enhancements
- [ ] Cost centers / Business units above departments
- [ ] Multiple reporting lines (dotted-line manager assignment)
- [ ] Improved org chart with export (PNG / PDF)
- [ ] Bulk user import via CSV (with role, dept, team mapping)
- [ ] User offboarding workflow (handover tasks, cancel leaves, archive data)
- [ ] Organization-level announcements / notice board

---

## TIER 4 — Operational & Compliance

### 16. Compliance & Data Privacy
- [ ] GDPR / PDPA: data export on request (right of access)
- [ ] Account deletion with full data purge option
- [ ] Consent tracking (record when user accepted ToS/Privacy Policy)
- [ ] Data retention policy: auto-delete old time entries / audit logs after N months (configurable)
- [ ] Privacy settings: control who can see whose hours (manager only vs. team-visible)
- [ ] Data residency option (region-specific deployment docs)

### 17. Structured Logging & Monitoring
| Gap | Solution |
|-----|----------|
| `console.error` everywhere | Winston / Pino with JSON output |
| No error tracking | Sentry SDK integration |
| No performance monitoring | Prometheus + Grafana or Datadog |
| No uptime monitoring | Health check endpoint + external pinger (UptimeRobot) |

- [ ] Replace all `console.error` / `console.log` with structured logger (Winston or Pino)
- [ ] Add Sentry for client-side and server-side error tracking
- [ ] Expose `/api/health` with DB connectivity check (endpoint exists, needs enhancement)
- [ ] Add request duration logging middleware
- [ ] Set up Prometheus metrics endpoint (`/metrics`)
- [ ] Configure alerting for error rate spikes, slow queries, disk usage

### 18. Database Backup & Recovery
- [ ] Automated daily SQLite backup (or `pg_dump` for PostgreSQL)
- [ ] Upload backups to S3 / GCS with retention policy
- [ ] Point-in-time recovery documentation
- [ ] Backup integrity verification (restore test)
- [ ] Disaster recovery runbook

### 19. Security Hardening
- [ ] Per-user API rate limits (not only IP-based)
- [ ] Account lockout after N failed login attempts (with unlock flow)
- [ ] IP allowlisting option for admin endpoints
- [ ] Server-side input length caps on all text fields
- [ ] Strong password policy enforced server-side (min length, complexity)
- [ ] Security headers middleware (Helmet.js — already partial, review config)
- [ ] Dependency vulnerability scanning (Dependabot or `npm audit` in CI)
- [ ] Regular penetration testing checklist

### 20. Test Suite
Currently **0% test coverage** — high regression risk.
- [ ] Unit tests for all server utilities (`timeCalc`, `approver`, `timezone`, `password`)
- [ ] Integration tests for all API routes (Supertest + Vitest or Jest)
- [ ] Auth middleware tests (role enforcement, org scoping)
- [ ] E2E tests for critical user flows: clock-in, leave request, approval (Playwright)
- [ ] Frontend component tests (React Testing Library)
- [ ] CI/CD pipeline with test gates (GitHub Actions / GitLab CI)
- [ ] Code coverage threshold enforcement (≥ 70%)

---

## Progress Tracker

| Tier | Feature | Status |
|------|---------|--------|
| 1 | PostgreSQL migration | ⬜ Not started |
| 1 | Email notifications | ⬜ Not started |
| 1 | In-app notification center | ⬜ Not started |
| 1 | SSO / OAuth2 | ⬜ Not started |
| 1 | HTTPS + secret management | ⬜ Not started |
| 2 | Two-factor authentication | ⬜ Not started |
| 2 | Reporting & exports | ⬜ Not started |
| 2 | Payroll integration | ⬜ Not started |
| 2 | Shift management | ⬜ Not started |
| 2 | Full-text search | ⬜ Not started |
| 3 | Performance reviews | ⬜ Not started |
| 3 | Onboarding workflow | ⬜ Not started |
| 3 | Webhooks / integrations | ⬜ Not started |
| 3 | Advanced leave features | ⬜ Not started |
| 3 | Org hierarchy enhancements | ⬜ Not started |
| 4 | GDPR / data privacy | ⬜ Not started |
| 4 | Structured logging & monitoring | ⬜ Not started |
| 4 | Database backup & recovery | ⬜ Not started |
| 4 | Security hardening | ⬜ Not started |
| 4 | Test suite | ⬜ Not started |

---

*Last updated: March 6, 2026*
