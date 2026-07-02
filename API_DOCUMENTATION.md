# WorkPulse API Documentation

> **Base URL**: `/api`  
> **Authentication**: JWT via HTTP-only cookies  
> **Rate Limiting**: General API (5000/15min), Auth endpoints have stricter limits noted below  
> **Content-Type**: `application/json` unless noted otherwise

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Time Tracker](#2-time-tracker)
3. [Leaves](#3-leaves)
4. [Tasks](#4-tasks)
5. [Sprints](#5-sprints)
6. [Profile](#6-profile)
7. [Organization](#7-organization)
8. [Admin](#8-admin)
9. [Manager](#9-manager)
10. [Leave Policy](#10-leave-policy)
11. [Calendar](#11-calendar)
12. [Notes](#12-notes)
13. [Chat & Calls](#13-chat--calls)
14. [Notifications](#14-notifications)
15. [Search](#15-search)
16. [Export](#16-export)
17. [Meetings & Video Conferencing](#17-meetings--video-conferencing)
18. [Health Check](#18-health-check)
19. [WebSocket Events — Chat](#19-websocket-events--chat)
20. [WebSocket Events — Voice & Video Calls](#20-websocket-events--voice--video-calls)
21. [WebSocket Events — Meeting Rooms](#21-websocket-events--meeting-rooms)
22. [Call Flow Reference](#22-call-flow-reference)
23. [Meeting Room Flow Reference](#23-meeting-room-flow-reference)
24. [Middleware Reference](#24-middleware-reference)
25. [Error Responses](#25-error-responses)
20. [Middleware Reference](#20-middleware-reference)
21. [Error Responses](#21-error-responses)

---

## 1. Authentication

Base path: `/api/auth`

### GET `/api/auth/registration-mode`
Get the current registration mode for the platform.

> **Deprecated** — self-serve registration has been removed from all clients
> (web, mobile, desktop). User enrollment is admin-only: tenant admins create
> users via Admin → Add People (`POST /api/admin/users` / bulk import), and
> platform admins provision users via the platform console
> (`POST /api/admin/tenants/:id/users`). The endpoint remains for backward
> compatibility only.

- **Auth**: None
- **Response**: `{ mode: "open" | "closed" | "invite_only" }`

### POST `/api/auth/register`
Register a new user account.

> **Deprecated** — no first-party client calls this endpoint anymore (the
> registration UI was removed). It is retained server-side for backward
> compatibility and is effectively disabled unless the tenant's
> `registration_mode` is explicitly set to `open` or `invite_only`
> (default is `invite_only`, requiring an admin-generated code).

- **Auth**: None
- **Rate Limit**: 10/15min
- **Body**:
  ```json
  {
    "username": "string (3-30 chars, alphanumeric/underscore/hyphen)",
    "password": "string (min 8 chars, uppercase, lowercase, number, special)",
    "full_name": "string",
    "email": "string (optional)",
    "invite_code": "string (required if mode is invite_only)"
  }
  ```
- **Response**: `201` Sets HTTP-only JWT cookie
  ```json
  {
    "user": { "id", "username", "full_name", "role", "must_change_password" }
  }
  ```
- **Errors**: `400` validation error, `409` username/email taken, `403` registration closed

### POST `/api/auth/login`
Authenticate with username and password.

- **Auth**: None
- **Rate Limit**: 15/15min
- **Body**:
  ```json
  {
    "username": "string",
    "password": "string"
  }
  ```
- **Response**: `200` Sets HTTP-only JWT cookie
  ```json
  {
    "user": {
      "id", "username", "full_name", "email", "role",
      "org_id", "department_id", "team_id", "manager_id",
      "avatar", "must_change_password", "has_reports"
    }
  }
  ```
- **Errors**: `401` invalid credentials, `403` account deactivated

### POST `/api/auth/forgot-password`
Request a password reset link via email.

- **Auth**: None
- **Rate Limit**: 5/15min
- **Body**: `{ "email": "string" }`
- **Response**: `200 { message: "If the email exists, a reset link was sent." }`

### POST `/api/auth/reset-password`
Reset password using a token from email link.

- **Auth**: None
- **Body**:
  ```json
  {
    "token": "string (from email link)",
    "password": "string (meets password policy)"
  }
  ```
- **Response**: `200 { message: "Password reset successful" }`
- **Errors**: `400` invalid/expired token

### POST `/api/auth/refresh`
Refresh the JWT token (extends session).

- **Auth**: `auth`, `loadUserContext`
- **Response**: `200` Sets new JWT cookie, returns full user object

### POST `/api/auth/logout`
Clear authentication cookies.

- **Auth**: None
- **Response**: `200 { message: "Logged out" }`

### Biometric login (mobile / desktop device credentials)

OS-biometric "login with your face / fingerprint". The device authenticator
unlocks a high-entropy secret; the server stores only its bcrypt hash. See
`docs/BIOMETRIC_LOGIN.md` for the full design.

#### POST `/api/auth/biometric/enroll`
Mint + store a device credential for the authenticated user.

- **Auth**: `auth`
- **Body**: `{ "platform": "ios" | "android" | "desktop" | "web", "deviceLabel"?: "string" }`
- **Response**: `200 { credentialId: "string", deviceSecret: "string (returned once)" }`

#### POST `/api/auth/biometric/login`
Exchange a device credential for a session (public; rate-limited).

- **Auth**: None
- **Body**: `{ "credentialId": "string", "deviceSecret": "string" }`
- **Response**: `200` Sets JWT cookie, returns the user object
- **Errors**: `401` invalid biometric credential

#### GET `/api/auth/biometric`
List the caller's enrolled device credentials.

- **Auth**: `auth`
- **Response**: `200 { devices: [{ id, device_label, platform, created_at, last_used_at }] }`

#### DELETE `/api/auth/biometric/:id`
Revoke one of the caller's device credentials.

- **Auth**: `auth`
- **Response**: `200 { message: "Biometric credential revoked" }`
- **Errors**: `404` not found / not owned by caller

### WebAuthn / passkeys (web biometric login)

Browser-native passwordless login. The platform authenticator holds the
private key; the server stores the public key + a signature counter.

#### POST `/api/auth/webauthn/register/options`
Return a passkey registration challenge for the authenticated user.

- **Auth**: `auth`
- **Response**: `200 { options, rpID, origin }`

#### POST `/api/auth/webauthn/register/verify`
Verify the attestation and store the public key.

- **Auth**: `auth`
- **Body**: `{ "response": PublicKeyCredential, "deviceLabel"?: "string" }`
- **Response**: `200 { verified: true }`
- **Errors**: `400` expired session / could not be verified

#### POST `/api/auth/webauthn/login/options`
Return a passkey authentication challenge (public; usernameless/discoverable).

- **Auth**: None
- **Response**: `200 { options, flowId }`

#### POST `/api/auth/webauthn/login/verify`
Verify the assertion and issue a session (public; rate-limited).

- **Auth**: None
- **Body**: `{ "response": PublicKeyCredential, "flowId": "string" }`
- **Response**: `200` Sets JWT cookie, returns the user object
- **Errors**: `400` expired session, `401` invalid passkey / verification failed

#### GET `/api/auth/webauthn`
List the caller's registered passkeys.

- **Auth**: `auth`
- **Response**: `200 { passkeys: [{ id, device_label, transports, created_at, last_used_at }] }`

#### DELETE `/api/auth/webauthn/:id`
Revoke one of the caller's passkeys.

- **Auth**: `auth`
- **Response**: `200 { message: "Passkey removed" }`
- **Errors**: `404` not found / not owned by caller

---

## 2. Time Tracker

Base path: `/api/tracker`

### GET `/api/tracker/status`
Get the current work status for today.

- **Auth**: `auth`, `loadUserContext`
- **Response**:
  ```json
  {
    "status": "clocked_out" | "working" | "on_break",
    "clock_in": "ISO timestamp",
    "current_break_start": "ISO timestamp | null",
    "breaks": [{ "start": "ISO", "end": "ISO" }],
    "work_mode": "office" | "remote" | "hybrid",
    "daily_target_minutes": 480,
    "floorMinutes": 420,
    "breakMinutes": 30
  }
  ```

### POST `/api/tracker/clock-in`
Clock in to start the work day.

- **Auth**: `auth`, `loadUserContext`
- **Body**:
  ```json
  {
    "work_mode": "office" | "remote" | "hybrid"
  }
  ```
- **Response**: `200 { message: "Clocked in", entry: { ... } }`
- **Errors**: `400` already clocked in

### POST `/api/tracker/break-start`
Start a break (must be currently working).

- **Auth**: `auth`
- **Response**: `200 { message: "Break started" }`
- **Errors**: `400` not clocked in or already on break

### POST `/api/tracker/break-end`
End current break and resume working.

- **Auth**: `auth`
- **Response**: `200 { message: "Break ended" }`
- **Errors**: `400` not on break

### POST `/api/tracker/clock-out`
Clock out to end the work day.

- **Auth**: `auth`
- **Response**: `200 { message: "Clocked out", summary: { floorMinutes, breakMinutes, totalMinutes } }`
- **Errors**: `400` not clocked in

### GET `/api/tracker/history`
Get time entry history for a date range.

- **Auth**: `auth`
- **Query**: `?from=YYYY-MM-DD&to=YYYY-MM-DD`
- **Response**: Array of daily entries with clock_in, clock_out, breaks, work_mode, floorMinutes, breakMinutes

### GET `/api/tracker/analytics`
Get aggregated analytics for the weekly chart.

- **Auth**: `auth`
- **Query**: `?days=7|14|30|90|365`
- **Response**: Array of `{ date, floorMinutes, breakMinutes, workMode }`

### GET `/api/tracker/manual-entries`
Get pending manual entry requests for the current user's approver.

- **Auth**: `auth`, `loadUserContext`
- **Response**: Array of manual entry requests with status

### POST `/api/tracker/manual-entry`
Submit a manual time entry (requires approval if user has a manager).

- **Auth**: `auth`, `loadUserContext`
- **Body**:
  ```json
  {
    "date": "YYYY-MM-DD",
    "clock_in": "HH:mm",
    "clock_out": "HH:mm",
    "breaks": [{ "start": "HH:mm", "end": "HH:mm" }],
    "timezoneOffset": -330,
    "work_mode": "office" | "remote" | "hybrid"
  }
  ```
- **Response**: `201 { message: "Manual entry submitted", request: { ... } }`

---

## 3. Leaves

Base path: `/api/leaves`

### GET `/api/leaves`
List leave requests (own or visible based on role).

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?from=YYYY-MM-DD&to=YYYY-MM-DD&status=pending|approved|rejected`
- **Response**: Array of leave objects

### GET `/api/leaves/summary`
Get daily leave summary for a date range.

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?from=YYYY-MM-DD&to=YYYY-MM-DD`
- **Response**: Array of `{ date, on_leave: boolean, leave_type }`

### GET `/api/leaves/monthly-summary`
Get monthly leave statistics.

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?month=YYYY-MM`
- **Response**: `{ total_days, approved, pending, rejected, by_type: { ... } }`

### GET `/api/leaves/balance`
Get leave balance for the current user and year.

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?year=2026`
- **Response**: Array of `{ leave_type, quota, used, remaining, carried_forward }`

### GET `/api/leaves/pending`
Get pending leave requests awaiting approval.

- **Auth**: `requireRole('manager')`
- **Response**: Array of pending leave requests with user details

### POST `/api/leaves`
Apply for leave (supports multi-day ranges).

- **Auth**: `auth`, `loadUserContext`
- **Body**:
  ```json
  {
    "leave_type": "casual" | "sick" | "earned" | "comp_off" | "unpaid",
    "start_date": "YYYY-MM-DD",
    "end_date": "YYYY-MM-DD",
    "reason": "string",
    "half_day": false,
    "half_day_period": "first_half" | "second_half"
  }
  ```
- **Response**: `201 { message: "Leave applied", leave: { ... } }`
- **Errors**: `400` insufficient balance, overlapping dates, weekend/holiday

### PATCH `/api/leaves/:id/approve`
Approve a leave request.

- **Auth**: `requireRole('manager')`
- **Body**: `{ "remarks": "string (optional)" }`
- **Response**: `200 { message: "Leave approved" }`

### PATCH `/api/leaves/:id/reject`
Reject a leave request.

- **Auth**: `requireRole('manager')`
- **Body**: `{ "reason": "string" }`
- **Response**: `200 { message: "Leave rejected" }`

---

## 4. Tasks

Base path: `/api/tasks`

### GET `/api/tasks`
List tasks with filtering and pagination.

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?sprint_id=&status=todo|in_progress|review|done&priority=low|medium|high|critical&assignee_id=&date=YYYY-MM-DD&search=&page=1&limit=50`
- **Response**:
  ```json
  {
    "tasks": [{ "id", "title", "description", "status", "priority", "assignee", "labels", "sprint_id", "created_at", "updated_at" }],
    "total": 100,
    "page": 1
  }
  ```

### POST `/api/tasks`
Create a new task.

- **Auth**: `auth`, `loadUserContext`
- **Body**:
  ```json
  {
    "title": "string",
    "description": "string (optional, markdown supported)",
    "status": "todo" | "in_progress" | "review" | "done",
    "priority": "low" | "medium" | "high" | "critical",
    "assignee_id": "uuid (optional)",
    "sprint_id": "uuid (optional)",
    "labels": ["label_id"],
    "due_date": "YYYY-MM-DD (optional)"
  }
  ```
- **Response**: `201 { task: { ... } }`

### PATCH `/api/tasks/:id/status`
Update task status (Kanban column move).

- **Auth**: `auth`, `loadUserContext`
- **Body**: `{ "status": "todo" | "in_progress" | "review" | "done" }`
- **Response**: `200 { task: { ... } }`

### PUT `/api/tasks/:id`
Update task details.

- **Auth**: `auth`, `loadUserContext`
- **Body**: Any subset of `{ title, description, priority, assignee_id, sprint_id, labels, due_date, status }`
- **Response**: `200 { task: { ... } }`

### DELETE `/api/tasks/:id`
Delete a task (creator only).

- **Auth**: `auth`, `loadUserContext`
- **Response**: `200 { message: "Task deleted" }`
- **Errors**: `403` not the creator

### POST `/api/tasks/carry-forward`
Carry forward incomplete tasks from the previous day to today.

- **Auth**: `auth`, `loadUserContext`
- **Body**: `{ "task_ids": ["uuid"] }`
- **Response**: `200 { carried: 3 }`

---

## 5. Sprints

Base path: `/api/sprints`

### GET `/api/sprints`
List team sprints sorted by status and start date.

- **Auth**: `auth`, `loadUserContext`
- **Response**: Array of sprint objects with task counts

### GET `/api/sprints/active`
Get the currently active sprint (cached in Redis).

- **Auth**: `auth`, `loadUserContext`
- **Response**: `{ sprint: { id, name, start_date, end_date, goal, status } }`

### POST `/api/sprints`
Create a new sprint.

- **Auth**: `auth`, `loadUserContext`, `requireRole('team_lead')`
- **Body**:
  ```json
  {
    "name": "Sprint 1",
    "start_date": "YYYY-MM-DD",
    "end_date": "YYYY-MM-DD",
    "goal": "string (optional)"
  }
  ```
- **Response**: `201 { sprint: { ... } }`

### PUT `/api/sprints/:id`
Update sprint details.

- **Auth**: `auth`, `loadUserContext`, `requireRole('team_lead')`
- **Body**: `{ name, start_date, end_date, goal, status: "planning"|"active"|"completed" }`
- **Response**: `200 { sprint: { ... } }`

### DELETE `/api/sprints/:id`
Delete a sprint.

- **Auth**: `auth`, `loadUserContext`, `requireRole('team_lead')`
- **Response**: `200 { message: "Sprint deleted" }`

### GET `/api/sprints/:id/tasks`
Get all tasks in a specific sprint.

- **Auth**: `auth`, `loadUserContext`
- **Response**: Array of task objects

---

## 6. Profile

Base path: `/api/profile`

### GET `/api/profile`
Get the current user's profile.

- **Auth**: `auth`
- **Response**: Full user object with org, department, team details

### PUT `/api/profile`
Update display name and username.

- **Auth**: `auth`
- **Body**: `{ "full_name": "string", "username": "string" }`
- **Response**: `200 { user: { ... } }`

### PUT `/api/profile/email`
Update email address.

- **Auth**: `auth`
- **Body**: `{ "email": "string" }`
- **Response**: `200 { message: "Email updated" }`
- **Errors**: `409` email already in use

### PUT `/api/profile/password`
Change password (requires current password).

- **Auth**: `auth`, `loadUserContext`
- **Rate Limit**: 10/15min
- **Body**: `{ "current_password": "string", "new_password": "string" }`
- **Response**: `200 { message: "Password changed" }`
- **Errors**: `401` wrong current password, `400` password policy not met

### POST `/api/profile/avatar`
Upload a profile avatar image.

- **Auth**: `auth`
- **Content-Type**: `multipart/form-data`
- **Body**: `avatar` file (jpg/png/webp/gif, max 10MB)
- **Response**: `200 { avatar: "/uploads/avatars/filename.jpg" }`

### DELETE `/api/profile/avatar`
Remove the profile avatar.

- **Auth**: `auth`
- **Response**: `200 { message: "Avatar removed" }`

### DELETE `/api/profile`
Delete user account (requires password confirmation).

- **Auth**: `auth`
- **Body**: `{ "password": "string" }`
- **Response**: `200 { message: "Account deleted" }`
- **Errors**: `401` wrong password

---

## 7. Organization

Base path: `/api/org`

### POST `/api/org`
Create a new organization (platform admin only).

- **Auth**: `requireRole('super_admin')`
- **Body**: `{ "name": "string", "domain": "string (optional)" }`
- **Response**: `201 { org: { ... } }`

### GET `/api/org/current`
Get the current user's organization details with counts.

- **Auth**: `auth`, `loadUserContext`
- **Response**:
  ```json
  {
    "id", "name", "domain",
    "settings": { "daily_hours", "work_days", "timezone", "fiscal_year_start" },
    "member_count", "department_count", "team_count"
  }
  ```

### PUT `/api/org/settings`
Update organization settings.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Body**:
  ```json
  {
    "daily_hours": 8,
    "work_days": ["mon","tue","wed","thu","fri"],
    "timezone": "Asia/Kolkata",
    "fiscal_year_start": "april"
  }
  ```
- **Response**: `200 { message: "Settings updated" }`

### GET `/api/org/members`
List organization members (paginated).

- **Auth**: `requireRole('team_lead')`, `requireSameOrg`
- **Query**: `?page=1&limit=20&search=&department_id=&team_id=&role=`
- **Response**: `{ members: [...], total: 50 }`

### POST `/api/org/invite`
Invite a user to the organization.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Body**: `{ "user_id": "uuid" }`
- **Response**: `200 { message: "User invited" }`

### POST `/api/org/remove-member`
Remove a member from the organization.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Body**: `{ "user_id": "uuid" }`
- **Response**: `200 { message: "Member removed" }`

### GET `/api/org/departments`
List departments with member counts.

- **Auth**: `requireSameOrg`
- **Response**: Array of `{ id, name, description, member_count }`

### POST `/api/org/departments`
Create a department.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Body**: `{ "name": "string", "description": "string (optional)" }`
- **Response**: `201 { department: { ... } }`

### PUT `/api/org/departments/:id`
Update a department.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Body**: `{ "name": "string", "description": "string" }`
- **Response**: `200 { department: { ... } }`

### DELETE `/api/org/departments/:id`
Delete a department.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Response**: `200 { message: "Department deleted" }`

### GET `/api/org/teams`
List teams with member counts.

- **Auth**: `requireSameOrg`
- **Response**: Array of `{ id, name, department_id, member_count }`

### POST `/api/org/teams`
Create a team.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Body**: `{ "name": "string", "department_id": "uuid (optional)" }`
- **Response**: `201 { team: { ... } }`

### PUT `/api/org/teams/:id`
Update a team.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Body**: `{ "name": "string", "department_id": "uuid" }`
- **Response**: `200 { team: { ... } }`

### DELETE `/api/org/teams/:id`
Delete a team.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Response**: `200 { message: "Team deleted" }`

### GET `/api/org/teams/:id/sprint-config`
Get team sprint configuration and current sprint.

- **Auth**: `requireSameOrg`
- **Response**: `{ sprint_duration: 14, sprint_start_day: "monday", current_sprint: { ... } }`

### PUT `/api/org/teams/:id/sprint-config`
Update sprint configuration for a team.

- **Auth**: `requireRole('team_lead')`, `requireSameOrg`
- **Body**: `{ "sprint_duration": 14, "sprint_start_day": "monday" }`
- **Response**: `200 { message: "Sprint config updated" }`

---

## 8. Admin

Base path: `/api/admin`

### GET `/api/admin/organizations`
List all organizations (platform admin only, paginated).

- **Auth**: `requireRole('platform_admin')`
- **Query**: `?page=1&limit=20&search=`
- **Response**: `{ organizations: [...], total: 5 }`

### GET `/api/admin/organizations/:id`
Get organization details with member/dept/team stats.

- **Auth**: `requireRole('platform_admin')`
- **Response**: Full organization object with statistics

### POST `/api/admin/organizations`
Create a new organization.

- **Auth**: `requireRole('platform_admin')`
- **Body**: `{ "name": "string", "domain": "string" }`
- **Response**: `201 { org: { ... } }`

### PUT `/api/admin/organizations/:id`
Update organization details and settings.

- **Auth**: `requireRole('platform_admin')`
- **Body**: `{ name, domain, settings: { daily_hours, work_days, timezone } }`
- **Response**: `200 { org: { ... } }`

### DELETE `/api/admin/organizations/:id`
Delete an organization (fails if active users exist).

- **Auth**: `requireRole('platform_admin')`
- **Response**: `200 { message: "Organization deleted" }`
- **Errors**: `400` org has active members

### GET `/api/admin/users`
List users with filtering and pagination.

- **Auth**: `auth`, `loadUserContext`, `requireRole('hr_admin')`
- **Query**: `?page=1&limit=20&search=&role=&status=active|deactivated&department_id=&team_id=`
- **Response**: `{ users: [...], total: 50 }`

### GET `/api/admin/users/:id`
Get detailed user information.

- **Auth**: `auth`, `loadUserContext`, `requireRole('hr_admin')`
- **Response**: Full user profile with org, department, team, manager details

### PUT `/api/admin/users/:id/role`
Change a user's role (creates an approval request for elevated roles).

- **Auth**: `auth`, `loadUserContext`, `requireRole('hr_admin')`
- **Body**: `{ "role": "employee" | "team_lead" | "manager" | "hr_admin" | "super_admin" }`
- **Response**: `200 { message: "Role updated" }` or `200 { message: "Role change request created", request: { ... } }`

### GET `/api/admin/role-requests`
List role change requests.

- **Auth**: `auth`, `loadUserContext`, `requireRole('hr_admin')`
- **Query**: `?status=pending|approved|rejected|cancelled`
- **Response**: Array of role change requests

### POST `/api/admin/role-requests/:id/approve`
Approve a role change request.

- **Auth**: `auth`, `loadUserContext`, `requireRole('hr_admin')`
- **Response**: `200 { message: "Role request approved" }`

### POST `/api/admin/role-requests/:id/reject`
Reject a role change request.

- **Auth**: `auth`, `loadUserContext`, `requireRole('hr_admin')`
- **Body**: `{ "reason": "string" }`
- **Response**: `200 { message: "Role request rejected" }`

### POST `/api/admin/role-requests/:id/cancel`
Cancel a pending role change request.

- **Auth**: `auth`, `loadUserContext`, `requireRole('hr_admin')`
- **Response**: `200 { message: "Role request cancelled" }`

### PUT `/api/admin/users/:id/assignment`
Update user's organization, department, team, and manager assignment.

- **Auth**: `auth`, `loadUserContext`, `requireRole('hr_admin')`
- **Body**:
  ```json
  {
    "org_id": "uuid",
    "department_id": "uuid | null",
    "team_id": "uuid | null",
    "manager_id": "uuid | null"
  }
  ```
- **Response**: `200 { message: "Assignment updated" }`

### PUT `/api/admin/users/:id/deactivate`
Deactivate a user account.

- **Auth**: `auth`, `loadUserContext`, `requireRole('hr_admin')`
- **Response**: `200 { message: "User deactivated" }`

---

## 9. Manager

Base path: `/api/manager`

### GET `/api/manager/team-attendance`
Get team attendance data for a specific date.

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?date=YYYY-MM-DD`
- **Response**:
  ```json
  {
    "members": [
      {
        "id", "full_name", "avatar", "role",
        "status": "working" | "on_break" | "clocked_out" | "on_leave" | "absent",
        "clock_in": "ISO", "floor_minutes": 420,
        "work_mode": "office", "tasks_completed": 3,
        "leave_type": "casual | null"
      }
    ]
  }
  ```

### GET `/api/manager/team-analytics`
Get team analytics with trends, leaves, tasks, and punctuality.

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?days=7|14|30&from=YYYY-MM-DD&to=YYYY-MM-DD`
- **Response**:
  ```json
  {
    "overview": { "total_hours", "avg_hours_per_day", "members_count" },
    "trends": [{ "date", "total_hours", "member_count" }],
    "member_stats": [{ "id", "name", "total_hours", "avg_hours", "tasks_done", "leaves_taken" }],
    "leave_summary": { "total", "by_type": {} },
    "task_summary": { "total", "completed", "in_progress" }
  }
  ```

### GET `/api/manager/approvals`
Get pending and completed approval requests.

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?status=pending|approved|rejected&type=leave|manual_entry|overtime`
- **Response**: Array of approval objects with requester details

### GET `/api/manager/my-requests`
Get requests submitted by users that await the current user's approval.

- **Auth**: `auth`, `loadUserContext`
- **Response**: Array of pending requests

### POST `/api/manager/approvals/:id/approve`
Approve a request (leave, manual entry, or overtime).

- **Auth**: `auth`, `loadUserContext`
- **Body**: `{ "remarks": "string (optional)" }`
- **Response**: `200 { message: "Request approved" }`

### POST `/api/manager/approvals/:id/reject`
Reject a request with an optional reason.

- **Auth**: `auth`, `loadUserContext`
- **Body**: `{ "reason": "string (optional)" }`
- **Response**: `200 { message: "Request rejected" }`

---

## 10. Leave Policy

Base path: `/api/leave-policy`

### GET `/api/leave-policy/policies`
List leave policies for the organization.

- **Auth**: `auth`, `loadUserContext`, `requireSameOrg`
- **Response**: Array of `{ id, name, leave_type, default_quota, carry_forward_limit, accrual_type }`

### POST `/api/leave-policy/policies`
Create or update a leave policy.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Body**:
  ```json
  {
    "name": "Casual Leave",
    "leave_type": "casual",
    "default_quota": 12,
    "carry_forward_limit": 5,
    "accrual_type": "yearly" | "monthly" | "none",
    "description": "string (optional)"
  }
  ```
- **Response**: `201 { policy: { ... } }`

### DELETE `/api/leave-policy/policies/:id`
Delete a leave policy.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Response**: `200 { message: "Policy deleted" }`

### GET `/api/leave-policy/balances`
Get the current user's leave balance (auto-initializes from policies if needed).

- **Auth**: `auth`
- **Response**: Array of `{ leave_type, quota, used, remaining, carried_forward }`

### GET `/api/leave-policy/balances/:userId`
Get another user's leave balance.

- **Auth**: `requireRole('team_lead')`, `requireSameOrg`
- **Response**: Same format as above

### PUT `/api/leave-policy/balances/:userId`
Manually adjust a user's leave balance.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Body**: `{ "leave_type": "casual", "quota": 15, "carried_forward": 3 }`
- **Response**: `200 { message: "Balance updated" }`

### GET `/api/leave-policy/holidays`
List company holidays for a year.

- **Auth**: `auth`, `loadUserContext`, `requireSameOrg`
- **Query**: `?year=2026`
- **Response**: Array of `{ id, name, date, type: "public" | "restricted" | "optional" }`

### POST `/api/leave-policy/holidays`
Add a company holiday.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Body**: `{ "name": "Republic Day", "date": "2026-01-26", "type": "public" }`
- **Response**: `201 { holiday: { ... } }`

### POST `/api/leave-policy/holidays/batch`
Add multiple holidays at once.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Body**: `{ "holidays": [{ "name", "date", "type" }] }`
- **Response**: `201 { count: 10 }`

### DELETE `/api/leave-policy/holidays/:id`
Delete a holiday.

- **Auth**: `requireRole('hr_admin')`, `requireSameOrg`
- **Response**: `200 { message: "Holiday deleted" }`

---

## 11. Calendar

Base path: `/api/calendar`

### GET `/api/calendar`
List calendar events for a date range.

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?from=YYYY-MM-DD&to=YYYY-MM-DD`
- **Response**: Array of events with linked tasks/meetings

### POST `/api/calendar`
Create a calendar event.

- **Auth**: `auth`, `loadUserContext`
- **Body**:
  ```json
  {
    "title": "string",
    "start": "ISO timestamp",
    "end": "ISO timestamp",
    "color": "#hex (optional)",
    "task_id": "uuid (optional)",
    "meeting_id": "uuid (optional)",
    "description": "string (optional)",
    "all_day": false
  }
  ```
- **Response**: `201 { event: { ... } }`

### PUT `/api/calendar/:id`
Update a calendar event.

- **Auth**: `auth`, `loadUserContext`
- **Body**: Any subset of `{ title, start, end, color, task_id, description, all_day }`
- **Response**: `200 { event: { ... } }`

### DELETE `/api/calendar/:id`
Delete a calendar event.

- **Auth**: `auth`, `loadUserContext`
- **Response**: `200 { message: "Event deleted" }`

---

## 12. Notes

Base path: `/api/notes`

### GET `/api/notes`
Get the user's notebook (full JSON structure).

- **Auth**: `auth`
- **Response**: `{ notebook: { pages: [...], order: [...] } }`

### PUT `/api/notes`
Save the entire notebook (max 2MB payload).

- **Auth**: `auth`
- **Body**: `{ "notebook": { "pages": [...], "order": [...] } }`
- **Response**: `200 { message: "Saved" }`
- **Errors**: `413` payload too large

### GET `/api/notes/history/:pageId`
Get version history for a specific notebook page (latest 50 snapshots).

- **Auth**: `auth`
- **Response**: Array of `{ id, page_id, snapshot, created_at }`

### GET `/api/notes/history/snapshot/:id`
Get a specific history snapshot.

- **Auth**: `auth`
- **Response**: `{ snapshot: { ... } }`

---

## 13. Chat & Calls

Base path: `/api/chat`

### GET `/api/chat/search`
Search users within the organization for starting conversations.

- **Auth**: `auth`
- **Query**: `?q=search_term`
- **Response**: Array of `{ id, username, full_name, avatar, email }`

### GET `/api/chat/presence`
Get online status for specific users.

- **Auth**: `auth`
- **Query**: `?user_ids=uuid1,uuid2`
- **Response**: `{ "uuid1": true, "uuid2": false }`

### POST `/api/chat/conversations`
Create a 1:1 conversation (returns existing if already exists).

- **Auth**: `auth`
- **Body**: `{ "user_id": "uuid" }`
- **Response**: `200 { conversation: { id, type: "direct", participants: [...] } }`

### POST `/api/chat/conversations/group`
Create a group conversation.

- **Auth**: `auth`
- **Body**: `{ "name": "Group Name", "user_ids": ["uuid1", "uuid2"] }`
- **Response**: `201 { conversation: { id, type: "group", name, participants: [...] } }`

### PUT `/api/chat/conversations/:id/group`
Update a group conversation.

- **Auth**: `auth`
- **Body**: `{ "name": "New Name", "add_users": ["uuid"], "remove_users": ["uuid"] }`
- **Response**: `200 { conversation: { ... } }`

### GET `/api/chat/conversations/:id/members`
List group conversation members.

- **Auth**: `auth`
- **Response**: Array of `{ id, username, full_name, avatar, role_in_group }`

### GET `/api/chat/conversations`
List user's conversations with unread counts and last message.

- **Auth**: `auth`
- **Response**: Array of conversation objects with `unread_count`, `last_message`, `participants`

### GET `/api/chat/conversations/:id/messages`
Get messages for a conversation (paginated, includes reactions).

- **Auth**: `auth`
- **Query**: `?before=message_id&limit=50`
- **Response**: Array of message objects with sender, reactions, reply_to, attachments

### POST `/api/chat/conversations/:id/read`
Mark conversation as read and send read receipt via WebSocket.

- **Auth**: `auth`
- **Response**: `200 { message: "Marked as read" }`

### POST `/api/chat/conversations/:id/messages`
Send a message (text or file).

- **Auth**: `auth`
- **Content-Type**: `multipart/form-data` (for files) or `application/json`
- **Body (JSON)**: `{ "content": "string", "reply_to": "msg_id (optional)", "format": "plain|markdown" }`
- **Body (multipart)**: `file` field (max 25MB) + optional `content` text
- **Supported file types**: Images, video, audio, documents, zip, office formats
- **Response**: `201 { message: { id, content, sender, created_at, attachments } }`

### POST `/api/chat/conversations/:id/messages/:msgId/react`
Add an emoji reaction to a message.

- **Auth**: `auth`
- **Body**: `{ "emoji": "👍" }`
- **Response**: `200 { message: "Reaction added" }`

### DELETE `/api/chat/conversations/:id/messages/:msgId/react`
Remove a reaction from a message.

- **Auth**: `auth`
- **Body**: `{ "emoji": "👍" }`
- **Response**: `200 { message: "Reaction removed" }`

### PUT `/api/chat/conversations/:id/messages/:msgId`
Edit a message (sender only).

- **Auth**: `auth`
- **Body**: `{ "content": "updated text" }`
- **Response**: `200 { message: { ..., edited: true, edited_at } }`

### DELETE `/api/chat/conversations/:id/messages/:msgId`
Delete a message (soft delete, sender only).

- **Auth**: `auth`
- **Response**: `200 { message: "Message deleted" }`

### GET `/api/chat/calls`
Get call history for the current user across all conversations.

- **Auth**: `auth`
- **Response**:
  ```json
  [
    {
      "id": "uuid",
      "caller_id": "uuid",
      "caller_name": "John Doe",
      "caller_avatar": "/uploads/avatars/john.jpg",
      "conversation_id": "uuid",
      "call_type": "voice" | "video",
      "status": "ended" | "missed" | "declined",
      "started_at": "ISO timestamp | null",
      "ended_at": "ISO timestamp | null",
      "duration": 145,
      "created_at": "ISO timestamp"
    }
  ]
  ```

### GET `/api/chat/calls/active`
Get the current active call for the user (if any).

- **Auth**: `auth`
- **Response**: `{ call: { id, caller_id, conversation_id, call_type, status, started_at } }` or `{ call: null }`

### GET `/api/chat/conversations/:id/calls`
Get call history for a specific conversation.

- **Auth**: `auth`
- **Response**: Array of call log objects (same format as `/api/chat/calls`)

---

## 14. Notifications

Base path: `/api/notifications`

### GET `/api/notifications`
Get the user's notifications (latest 50) with unread count.

- **Auth**: `auth`, `loadUserContext`
- **Response**:
  ```json
  {
    "notifications": [
      {
        "id", "type": "leave_approved|task_assigned|meeting_invite|...",
        "title", "body", "data": {},
        "read": false, "created_at"
      }
    ],
    "unread_count": 5
  }
  ```

### POST `/api/notifications/read-all`
Mark all notifications as read.

- **Auth**: `auth`, `loadUserContext`
- **Response**: `200 { message: "All marked as read" }`

### POST `/api/notifications/:id/read`
Mark a single notification as read.

- **Auth**: `auth`, `loadUserContext`
- **Response**: `200 { message: "Marked as read" }`

### DELETE `/api/notifications/:id`
Delete a notification.

- **Auth**: `auth`, `loadUserContext`
- **Response**: `200 { message: "Notification deleted" }`

---

## 15. Search

Base path: `/api/search`

### GET `/api/search`
Global full-text search across all entities.

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?q=search_term` (minimum 2 characters)
- **Response**:
  ```json
  {
    "tasks": [{ "id", "title", "status", "priority" }],
    "notes": [{ "page_id", "title", "snippet" }],
    "users": [{ "id", "username", "full_name" }],
    "events": [{ "id", "title", "start" }],
    "leaves": [{ "id", "leave_type", "status" }],
    "sprints": [{ "id", "name", "status" }],
    "audit_logs": [{ "id", "action", "details" }]
  }
  ```

---

## 16. Export

Base path: `/api/export`

All export endpoints support both **CSV** and **PDF** formats via the `format` query parameter.

### GET `/api/export/my-analytics`
Export personal analytics data.

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|pdf`
- **Response**: File download (CSV or PDF)

### GET `/api/export/my-leaves`
Export personal leave history.

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|pdf`
- **Response**: File download

### GET `/api/export/my-tasks`
Export personal tasks.

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?sprint_id=&status=&format=csv|pdf`
- **Response**: File download

### GET `/api/export/team-analytics`
Export team analytics data.

- **Auth**: `requireRole('team_lead')`
- **Query**: `?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|pdf`
- **Response**: File download

### GET `/api/export/payroll-hours`
Export payroll hours with summary and detail rows.

- **Auth**: `requireRole('team_lead')`
- **Query**: `?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|pdf`
- **Response**: File download with per-employee breakdown

---

## 17. Meetings & Video Conferencing

Base path: `/api/meetings`

Meetings support real-time video conferencing with WebRTC mesh topology, in-meeting chat, screen sharing, hand raising, and organizer moderation controls. Meeting rooms connect via WebSocket events documented in [Section 21](#21-websocket-events--meeting-rooms).

### POST `/api/meetings/check-conflicts`
Check calendar conflicts for participants before scheduling.

- **Auth**: `auth`
- **Body**: `{ "start": "ISO", "end": "ISO", "participant_ids": ["uuid"] }`
- **Response**: `{ conflicts: [{ user_id, event_title, start, end }] }`

### GET `/api/meetings`
List the user's meetings (filterable by status).

- **Auth**: `auth`, `loadUserContext`
- **Query**: `?status=scheduled|active|ended|cancelled`
- **Response**:
  ```json
  [
    {
      "id": "uuid",
      "code": "abc-def-ghi",
      "title": "Sprint Planning",
      "organizer": { "id", "full_name", "avatar" },
      "status": "scheduled",
      "scheduled_start": "ISO",
      "scheduled_end": "ISO",
      "started_at": "ISO | null",
      "ended_at": "ISO | null",
      "duration": null,
      "participant_count": 5,
      "settings": {
        "mute_on_join": false,
        "allow_screen_share": true
      }
    }
  ]
  ```

### GET `/api/meetings/:code`
Get meeting details by meeting code (used for the join page). Results are cached in Redis.

- **Auth**: `auth`, `loadUserContext`
- **Response**:
  ```json
  {
    "meeting": {
      "id", "code", "title", "description",
      "organizer": { "id", "full_name", "avatar" },
      "status": "scheduled" | "active" | "ended" | "cancelled",
      "scheduled_start": "ISO",
      "scheduled_end": "ISO",
      "started_at": "ISO | null",
      "conversation_id": "uuid",
      "settings": { "mute_on_join": false, "allow_screen_share": true },
      "participants": [
        { "user_id", "full_name", "avatar", "role": "organizer" | "participant", "required": true, "joined_at": "ISO | null", "left_at": "ISO | null" }
      ]
    }
  }
  ```

### POST `/api/meetings`
Create a new meeting. Auto-generates a unique meeting code, creates a group conversation for in-meeting chat, and creates calendar events for all participants.

- **Auth**: `auth`, `loadUserContext`
- **Body**:
  ```json
  {
    "title": "Sprint Planning",
    "scheduled_start": "ISO timestamp",
    "scheduled_end": "ISO timestamp",
    "participant_ids": ["uuid1", "uuid2"],
    "description": "string (optional)",
    "settings": {
      "mute_on_join": false,
      "allow_screen_share": true
    }
  }
  ```
- **Response**: `201 { meeting: { id, code, title, conversation_id, ... } }`
- **Side effects**: Sends `meeting_invite` WebSocket event to all participants, creates calendar events

### PUT `/api/meetings/:id`
Update meeting details and settings (organizer only).

- **Auth**: `auth`, `loadUserContext`
- **Body**: `{ title, scheduled_start, scheduled_end, description, settings: { mute_on_join, allow_screen_share } }`
- **Response**: `200 { meeting: { ... } }`

### DELETE `/api/meetings/:id`
Cancel a meeting (organizer only). Sends notifications and WebSocket events to all participants.

- **Auth**: `auth`, `loadUserContext`
- **Response**: `200 { message: "Meeting cancelled" }`
- **Side effects**: Sends `meeting_cancelled` WebSocket event, deletes associated calendar events

### GET `/api/meetings/:id/participants`
List meeting participants with join status and role.

- **Auth**: `auth`, `loadUserContext`
- **Response**:
  ```json
  [
    {
      "user_id": "uuid",
      "full_name": "Jane Smith",
      "avatar": "/uploads/avatars/jane.jpg",
      "role": "organizer" | "participant",
      "required": true,
      "joined_at": "ISO | null",
      "left_at": "ISO | null"
    }
  ]
  ```

### POST `/api/meetings/:id/participants`
Add a participant to an existing meeting (with conflict detection).

- **Auth**: `auth`, `loadUserContext`
- **Body**: `{ "user_id": "uuid", "required": true }`
- **Response**: `200 { message: "Participant added" }`
- **Side effects**: Sends `meeting_invite` WebSocket event to added user

### DELETE `/api/meetings/:id/participants/:userId`
Remove a participant from a meeting.

- **Auth**: `auth`, `loadUserContext`
- **Response**: `200 { message: "Participant removed" }`
- **Side effects**: Sends `meeting_removed` WebSocket event to the removed user

---

## 18. Health Check

### GET `/api/health`
Health check endpoint that validates database connectivity.

- **Auth**: None
- **Response**: `200 { status: "ok", db: "connected" }`
- **On failure**: `503 { status: "error", db: "disconnected" }`

---

## 19. WebSocket Events — Chat

WorkPulse uses Socket.IO for real-time communication. All WebSocket connections authenticate via JWT cookie.

### Connection
```javascript
const socket = io('/ws', {
  withCredentials: true    // JWT sent via HTTP-only cookie
});
socket.emit('join');       // Join user's notification rooms
```

**Architecture**: Redis Pub/Sub relays events across multiple server instances. Each instance has a unique `INSTANCE_ID` for deduplication. Heartbeat interval: 30 seconds.

### Chat Events — Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `chat_message` | `{ conversationId, message: { id, content, sender, created_at, attachments, reply_to } }` | New message in a conversation |
| `chat_read_receipt` | `{ conversationId, userId, readAt }` | User read the conversation |
| `chat_group_created` | `{ conversation: { id, name, type, participants } }` | You were added to a new group |
| `chat_group_added` | `{ conversationId, user: { id, full_name, avatar } }` | User added to a group you're in |
| `chat_group_removed` | `{ conversationId, userId }` | User removed from a group you're in |
| `chat_message_edited` | `{ conversationId, message: { id, content, edited_at } }` | A message was edited |
| `chat_message_deleted` | `{ conversationId, messageId }` | A message was deleted |
| `chat_reaction` | `{ conversationId, messageId, reactions: { emoji: [userId] } }` | Reaction added/removed |

### General Notification Events — Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `leave_update` | `{ leave: { id, status, leave_type, user_id } }` | Leave request status changed |
| `task_assigned` | `{ task: { id, title, assignee_id } }` | Task assigned to you |
| `approval_update` | `{ request: { id, type, status } }` | Approval request status changed |

---

## 20. WebSocket Events — Voice & Video Calls

Voice and video calls use **WebRTC peer-to-peer** connections with WebSocket signaling. Calls are logged in the `call_logs` database table with full status tracking and duration.

### Call Events — Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `call_initiate` | `{ conversationId, callType: "voice" \| "video" }` | Start a call. Server creates a `call_logs` entry (status=`ringing`) and broadcasts `call_incoming` to all conversation participants |
| `call_accept` | `{ callId, conversationId }` | Accept an incoming call. Server updates status to `answered` with `started_at` timestamp |
| `call_reject` | `{ callId, conversationId }` | Reject an incoming call. Server updates status to `declined` |
| `call_end` | `{ callId, conversationId }` | End an active call. Server calculates duration, sets `ended_at`, updates status to `ended` |
| `call_signal` | `{ conversationId, targetUserId, signal: { type: "offer" \| "answer" \| "ice-candidate", sdp?, candidate? } }` | Relay WebRTC signaling data to a specific peer |
| `call_reconnect` | `{ callId, conversationId }` | Notify peers after a page refresh during an active call. Peers will re-offer WebRTC connections |
| `call_add_participant` | `{ callId, conversationId, targetUserId }` | Add a third participant to an active call (upgrades 1:1 → group) |

### Call Events — Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `call_incoming` | `{ callId, callerId, callerName, callerAvatar, conversationId, callType: "voice" \| "video", isGroup, isJoining }` | Incoming call notification. `isJoining=true` when added to an existing group call |
| `call_accepted` | `{ callId, acceptedBy: userId }` | Call was accepted by the callee. Caller should create WebRTC offer |
| `call_rejected` | `{ callId, rejectedBy: userId }` | Call was rejected |
| `call_ended` | `{ callId, endedBy: userId }` | Call was ended by one of the participants |
| `call_signal` | `{ signal: { type, sdp?, candidate? }, fromUserId }` | WebRTC signaling data relayed from a peer |
| `call_reconnect` | `{ callId, userId }` | Peer has reconnected after a page refresh; re-offer WebRTC connection |

### Call Log Database Schema

```
call_logs:
  id            UUID PRIMARY KEY
  caller_id     UUID → users.id
  conversation_id UUID → conversations.id
  call_type     VARCHAR ('voice' | 'video')
  status        VARCHAR ('ringing' | 'answered' | 'declined' | 'missed' | 'ended')
  started_at    TIMESTAMP (set when accepted)
  ended_at      TIMESTAMP (set when ended)
  duration      INTEGER (seconds, calculated on end)
  created_at    TIMESTAMP DEFAULT NOW()
```

### Call Status Lifecycle

```
  ┌─────────┐    accept    ┌──────────┐    end    ┌───────┐
  │ ringing │───────────►  │ answered │────────►  │ ended │
  └─────────┘              └──────────┘           └───────┘
       │                                               
       ├── reject ──► declined                         
       └── timeout ─► missed (60s no response)         
```

---

## 21. WebSocket Events — Meeting Rooms

Meeting rooms support multi-participant video conferencing using **WebRTC mesh topology** (peer-to-peer between all participants). All meeting state is managed via WebSocket events.

### Meeting Events — Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `meeting_join` | `{ meetingId }` | Join a meeting room. Server marks participant as active, sets `joined_at`, updates meeting status to `active` if first joiner. Returns list of existing peers |
| `meeting_leave` | `{ meetingId }` | Leave a meeting room. Server sets `left_at`. If last participant, meeting status becomes `ended` with duration calculated |
| `meeting_end` | `{ meetingId }` | End the meeting for everyone (organizer only). Calculates total duration, sets all participants as left |
| `meeting_signal` | `{ meetingId, targetUserId, signal: { type: "offer" \| "answer" \| "ice-candidate", sdp?, candidate? } }` | Relay WebRTC signaling data to a specific peer in the meeting |
| `meeting_track_state` | `{ meetingId, muted: bool, videoOff: bool, screenSharing: bool }` | Broadcast local media state changes to all participants |
| `meeting_chat` | `{ meetingId, content: "string" }` | Send an in-meeting chat message |
| `meeting_raise_hand` | `{ meetingId, raised: bool }` | Raise or lower hand for moderation |
| `meeting_mute_participant` | `{ meetingId, targetUserId }` | Mute a participant's microphone (organizer only) |
| `meeting_add_participant` | `{ meetingId, targetUserId }` | Add a participant to an active meeting (organizer only) |

### Meeting Events — Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `meeting_participant_joined` | `{ meetingId, user: { id, full_name, avatar }, existingPeers: [{ id, full_name, avatar }] }` | A participant joined the room. New joiner receives `existingPeers` to establish WebRTC with each |
| `meeting_participant_left` | `{ meetingId, userId }` | A participant left the room |
| `meeting_ended` | `{ meetingId, endedBy: userId }` | Meeting was ended by the organizer |
| `meeting_signal` | `{ meetingId, signal: { type, sdp?, candidate? }, fromUserId }` | WebRTC signaling data relayed from a peer |
| `meeting_track_state` | `{ meetingId, userId, muted, videoOff, screenSharing }` | Media state update from a participant |
| `meeting_message` | `{ meetingId, sender: { id, full_name, avatar }, content, timestamp }` | In-meeting chat message |
| `meeting_hand_raised` | `{ meetingId, userId, raised: bool }` | Hand raise/lower notification |
| `meeting_muted` | `{ meetingId, userId, mutedBy: userId }` | Your mic was muted by the organizer |
| `meeting_invite` | `{ meeting: { id, code, title, organizer } }` | You were invited to a meeting |
| `meeting_cancelled` | `{ meetingId }` | Meeting was cancelled by the organizer |
| `meeting_removed` | `{ meetingId }` | You were removed from a meeting |

### Meeting Room Features

| Feature | How it works |
|---------|--------------|
| **Video/Audio** | WebRTC mesh — each participant connects P2P with every other participant |
| **Screen Sharing** | Controlled by `allow_screen_share` setting. Track replacement via `replaceTrack()` |
| **Mute on Join** | Enforced at join time if `mute_on_join` setting is enabled |
| **Organizer Mute** | Organizer can remotely mute any participant via `meeting_mute_participant` |
| **Hand Raising** | Participants raise/lower hand; visible to all via `meeting_hand_raised` |
| **In-Meeting Chat** | Text messages via `meeting_chat` events, stored in meeting conversation |
| **PiP Mode** | Client-side Picture-in-Picture when navigating away from meeting page |
| **Auto-End** | Meeting ends automatically when the last participant leaves |

### Meeting Participant Database Schema

```
meeting_participants:
  meeting_id    UUID → meetings.id
  user_id       UUID → users.id
  role          VARCHAR ('organizer' | 'participant')
  required      BOOLEAN DEFAULT true
  joined_at     TIMESTAMP (set on meeting_join)
  left_at       TIMESTAMP (set on meeting_leave)
  PRIMARY KEY (meeting_id, user_id)
```

---

## 22. Call Flow Reference

### 1:1 Voice/Video Call

```
Caller                          Server                         Callee
  │                               │                              │
  ├── call_initiate ─────────────►│                              │
  │   {conversationId, callType}  │── call_incoming ────────────►│
  │                               │   {callId, callerName, ...}  │
  │                               │                              │
  │                               │◄──────── call_accept ────────┤
  │◄── call_accepted ─────────────│   {callId, conversationId}   │
  │   {callId, acceptedBy}        │                              │
  │                               │                              │
  ├── call_signal (offer) ───────►│── call_signal (offer) ──────►│
  │◄── call_signal (answer) ──────│◄─ call_signal (answer) ──────┤
  │◄─► call_signal (ICE) ────────►│◄─► call_signal (ICE) ───────►│
  │                               │                              │
  │     ═══ P2P Connected ═══     │     ═══ P2P Connected ═══    │
  │                               │                              │
  ├── call_end ──────────────────►│── call_ended ───────────────►│
  │                               │   (duration calculated)      │
```

### Group Call (Add Participant)

```
Participant A (in call)         Server                    Participant C (new)
  │                               │                              │
  ├── call_add_participant ──────►│                              │
  │   {targetUserId: C}           │── call_incoming ────────────►│
  │                               │   {isGroup:true, isJoining:true}
  │                               │                              │
  │                               │◄──────── call_accept ────────┤
  │◄── call_signal ◄──────────────│─► call_signal ──────────────►│
  │     (WebRTC mesh A↔C)         │     (WebRTC mesh B↔C)        │
```

### Call Recovery (Page Refresh)

```
User (refreshed)                Server                    Other Peer
  │                               │                              │
  ├── call_reconnect ────────────►│── call_reconnect ───────────►│
  │   {callId, conversationId}    │   {callId, userId}           │
  │                               │                              │
  │◄── call_signal (offer) ───────│◄─ call_signal (offer) ───────┤
  │     (peer re-offers)          │     (re-establishes WebRTC)  │
```

---

## 23. Meeting Room Flow Reference

### Joining a Meeting

```
New Participant                  Server                    Existing Participants
  │                               │                              │
  ├── meeting_join ──────────────►│                              │
  │   {meetingId}                 │── meeting_participant_joined►│
  │                               │   {user, existingPeers}      │
  │◄── meeting_participant_joined─│                              │
  │   {existingPeers: [A, B]}     │                              │
  │                               │                              │
  │   For each existing peer:     │                              │
  ├── meeting_signal (offer) ────►│── meeting_signal ───────────►│
  │◄── meeting_signal (answer) ───│◄─ meeting_signal ────────────┤
  │◄─► meeting_signal (ICE) ─────►│◄─► meeting_signal ──────────►│
  │                               │                              │
  │     ═══ Mesh Connected ═══    │                              │
```

### Real-Time Features During Meeting

```
Participant                      Server                    All Others
  │                               │                              │
  ├── meeting_track_state ───────►│── meeting_track_state ──────►│
  │   {muted:true}                │   {userId, muted:true}       │
  │                               │                              │
  ├── meeting_raise_hand ────────►│── meeting_hand_raised ──────►│
  │   {raised:true}               │   {userId, raised:true}      │
  │                               │                              │
  ├── meeting_chat ──────────────►│── meeting_message ──────────►│
  │   {content:"Hello"}           │   {sender, content, time}    │
  │                               │                              │
Organizer ── meeting_mute_participant ►│── meeting_muted ────────►│
  │          {targetUserId}              │   {userId, mutedBy}     Target
```

### Ending a Meeting

```
Organizer                        Server                    All Participants
  │                               │                              │
  ├── meeting_end ───────────────►│── meeting_ended ────────────►│
  │   {meetingId}                 │   {meetingId, endedBy}       │
  │                               │   (duration calculated,      │
  │                               │    all left_at set,          │
  │                               │    status='ended')           │

  OR: Last participant leaves:
  │                               │                              │
  ├── meeting_leave ─────────────►│   (auto-ends meeting if      │
  │   {meetingId}                 │    no participants remain)   │
```

---

## 24. Middleware Reference

### `auth`
Validates the JWT token from HTTP-only cookies. Extracts `req.userId` and `req.username`. Returns `401` if token is missing or invalid.

### `loadUserContext`
Loads the user's organization context after authentication. Sets:
- `req.userOrgId` — Organization ID
- `req.userTeamId` — Team ID
- `req.userRole` — Role string
- `req.roleLevel` — Numeric role level (1-6)
- `req.managerId` — Direct manager's user ID

### `requireRole(minRole)`
Enforces minimum role level. Role hierarchy (ascending):
1. `employee` (level 1)
2. `team_lead` (level 2)
3. `manager` (level 3)
4. `hr_admin` (level 4)
5. `super_admin` (level 5)
6. `platform_admin` (level 6)

Returns `403` if user's role level is below the minimum.

### `requireSameOrg`
Ensures the user is operating within their own organization context. Prevents cross-org data access. Returns `403` if org mismatch.

### Rate Limiting
| Scope | Limit | Window |
|-------|-------|--------|
| Login | 15 requests | 15 minutes |
| Register | 10 requests | 15 minutes |
| Forgot Password | 5 requests | 15 minutes |
| Change Password | 10 requests | 15 minutes |
| General API | 5000 requests | 15 minutes |

---

## 25. Error Responses

All error responses follow a consistent format:

```json
{
  "error": "Human-readable error message"
}
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Resource created |
| `400` | Bad request / validation error |
| `401` | Unauthorized (invalid/missing token) |
| `403` | Forbidden (insufficient permissions) |
| `404` | Resource not found |
| `409` | Conflict (duplicate resource) |
| `413` | Payload too large |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

### Common Validation Errors

```json
// Username validation
{ "error": "Username must be 3-30 characters (letters, numbers, _ -)" }

// Password validation
{ "error": "Password must be at least 8 characters with uppercase, lowercase, number, and special character" }

// Leave balance
{ "error": "Insufficient leave balance for casual leave" }

// Date validation
{ "error": "Start date must be before end date" }

// File upload
{ "error": "File type not allowed. Supported: jpg, png, webp, gif" }
{ "error": "File size exceeds maximum of 25MB" }
```

---

## Upload Constraints

| Upload Type | Max Size | Allowed Types |
|------------|----------|---------------|
| Avatar | 10 MB | jpg, png, webp, gif |
| Chat file | 25 MB | Images, video, audio, documents, zip, office formats |
| Notebook | 2 MB | JSON payload |

---

*Generated from WorkPulse server route analysis. Last updated: April 2026.*
