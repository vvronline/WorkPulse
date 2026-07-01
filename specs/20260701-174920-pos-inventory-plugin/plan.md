# Implementation Plan: Point of Sale & Inventory Management Plugin

**Branch**: `20260701-174920-pos-inventory-plugin` | **Date**: 2026-07-01 | **Spec**: `specs/20260701-174920-pos-inventory-plugin/spec.md`

**Input**: Feature specification from `specs/20260701-174920-pos-inventory-plugin/spec.md`

## Summary

Deliver two plan-gated feature modules — **Inventory Management** (`inventory`) and **Point of Sale** (`pos`) — as first-class WorkPulse plugins using the existing feature-flag system (`planCatalog.ts` + `requireFeature`/`hasFeature`), the additive per-tenant migration registry (`migrationRunner.ts`), the native `ws` real-time stack, and the RBAC/audit/notifications infrastructure. Inventory is an append-only stock ledger (ERPNext pattern) with a denormalized balance table (Medusa `InventoryLevel`) and reservations (Saleor `Allocation`); POS is an offline-first retail terminal with an Odoo-style cash-session lifecycle and multi-tender payments that sells through the inventory ledger. All valuation writes funnel through a single `ValuationService` (single-writer rule, ADR-0001 precedent). See `research.md` for the market analysis and the ranked reference systems (Medusa v2, Odoo Community, Vendure, ERPNext, Saleor).

## Technical Context

**Language/Version**: TypeScript (Node.js + Express 5) server; React 18 + Vite 7 client. All server files `.ts`.

**Primary Dependencies**: Existing only — `pg`, native `ws`, Pino, BullMQ/Redis (optional), Multer, `express-rate-limit`, Vitest/Jest+Supertest. **New client-only dep candidate**: a barcode scanner lib (e.g. `@zxing/browser`, MIT) for camera scanning — justified in the PR per Constitution stack rules; keyboard-wedge scanning needs no dependency. No new server dependencies.

**Storage**: PostgreSQL, per-tenant DB. ~30 new tenant tables (see `data-model.md`) via 6 additive migrations `2026_07_v20`–`v25`.

**Testing**: Jest + Supertest (server routes + `ValuationService` + POS session state machine); Vitest + RTL (POS terminal + inventory grids); plan-gating test row for `inventory` + `pos`.

**Target Platform**: Web (desktop-first POS terminal, responsive), Electron desktop shell reuse. Mobile app is out of scope for v1.

**Project Type**: Multi-tenant web service + SPA (existing structure).

**Performance Goals**: Cross-terminal stock update ≤3s (SC-003); barcode-scan → cart-add ≤150ms local; offline sync of a queued sale ≤2s after reconnect.

**Constraints**: Money `NUMERIC(14,4)` (no floats); append-only ledger; idempotent offline sync keyed `(session_id, client_order_uuid)`; `ws` only (no Socket.io); fail-closed feature gates; no GPL/LGPL source copied.

**Scale/Scope**: Retail POS v1. Deferred: restaurant mode, full GL/double-entry, IoT hardware proxy, multi-currency-per-register, mobile POS.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **I. Multi-Tenancy Isolation** — All tables `org_id`-scoped inside the per-tenant DB; all queries use `req.db` (request-scoped pool). No client-supplied tenant/org override. No cross-tenant access; barcode/SKU uniqueness is `UNIQUE(org_id, …)`.
- [x] **II. Security-First** — Routes behind `auth` + `loadUserContext` + `requireRole`; JWT stays in HttpOnly cookies; `apiLimiter` on all `/api/inventory` + `/api/pos` mounts; refund/void/discount-override require `requireRole('manager')`; receipts/exports served through authenticated static middleware; all inputs validated/sanitized before DB and WS broadcast.
- [x] **III. Real-Time Reliability** — Stock-level + terminal events go through `ws` wrapped with `wsValidate` (typed payloads), `wsIdempotency` (dedupe), `wsMetrics` (timing/soft-timeout). Offline sale sync is idempotent by `(session_id, client_order_uuid)` UNIQUE. `ValuationService` is the single writer to `stock_ledger`/`stock_levels`; POS session and stock state transitions are audited.
- [x] **IV. Test Coverage** — Every new route gets a happy-path + primary-error Jest+Supertest test; `ValuationService` (FIFO/AVCO/Standard, reservation, reversal) and the POS session state machine get per-transition unit tests; POS terminal + data-mutation client components get Vitest tests; plan-gating test extended.
- [x] **V. Observability** — Pino structured logs + audit rows (`logAction`) for every stock movement, session open/close, cash in/out, sale, refund, void, and discount override, with `org_id/user_id/route/doc` context. No silent failures.
- [x] **VI. Simplicity** — Reuses the existing plugin/feature mechanism (no new service); single `stock_movements` semantics via one ledger table; returns reuse `pos_orders` (no extra table); one `ValuationService` abstraction (used by receipts, sales, transfers, adjustments — ≥2 callers). New feature flags default OFF (opt-in). Only one optional client dep (barcode), justified.
- [x] **VII. Mobile Platform Reliability** — N/A for v1 (no mobile POS). If a future phase adds mobile scanning, it will follow FCM/Expo Router/secure-store rules. Flagged in Complexity Tracking as out of scope.

## Project Structure

### Documentation (this feature)

```text
specs/20260701-174920-pos-inventory-plugin/
├── plan.md              # This file
├── research.md          # Market analysis + architecture decisions (done)
├── data-model.md        # Full schema (done)
├── quickstart.md        # Local validation flow
├── contracts/
│   ├── inventory-api.md
│   └── pos-api.md
└── tasks.md             # /speckit.tasks output (not created by plan)
```

### Source Code (repository root)

```text
server/
├── routes/
│   ├── inventory/
│   │   ├── index.ts            # mounts sub-routers, router.use(requireTenant, requireFeature('inventory'))
│   │   ├── products.ts         # products, variants, barcodes, categories, uoms
│   │   ├── warehouses.ts       # warehouses, locations (tree)
│   │   ├── stock.ts            # levels, ledger read, adjustments, transfers, lots
│   │   ├── purchasing.ts       # suppliers, POs, goods receipts
│   │   └── reorder.ts          # reorder rules + alerts
│   └── pos/
│       ├── index.ts            # router.use(requireTenant, requireFeature('pos'))
│       ├── config.ts           # registers, payment methods, tax rates, price lists, discounts
│       ├── sessions.ts         # open/close/cash-in-out, reconciliation
│       ├── orders.ts           # cart→sale, offline sync (idempotent), receipts
│       └── returns.ts          # refunds/returns
├── services/
│   ├── inventory/
│   │   ├── ValuationService.ts # SINGLE WRITER to stock_ledger + stock_levels; FIFO/AVCO/Standard
│   │   ├── ReservationService.ts
│   │   └── ReorderScheduler.ts # BullMQ job (setInterval fallback) → notifications
│   └── pos/
│       ├── PosSessionService.ts# session state machine + cash reconciliation
│       └── PosOrderService.ts  # order totals, tax, idempotent sync, stock decrement via ValuationService
├── utils/
│   ├── migrationRunner.ts      # APPEND migrations v20–v25
│   └── planCatalog.ts          # add 'inventory' + 'pos' to FEATURE_LABELS + plan defaults + dependency rule
├── middleware/tenant.ts        # (reuse requireFeature; add pos→inventory dependency note)
├── ws/                         # extend existing ws dispatch with inventory/pos events (wsValidate/idempotency/metrics)
└── __tests__/
    ├── inventory.valuation.test.ts
    ├── inventory.routes.test.ts
    ├── pos.session.test.ts
    ├── pos.orders.idempotency.test.ts
    └── planGating.test.ts       # extend with inventory + pos rows

client/
├── src/
│   ├── pages/
│   │   ├── inventory/           # Products, Warehouses, StockLevels, Purchasing, Adjustments, Transfers
│   │   └── pos/                 # Terminal, Sessions, Registers, Reports
│   ├── components/
│   │   ├── inventory/           # ProductForm, LocationTree, StockGrid, ReceiveGoodsModal
│   │   └── pos/                 # Cart, PaymentPanel, BarcodeInput, ReceiptPreview, SessionCloseModal
│   ├── contexts/PosTerminalContext.tsx   # offline queue (IndexedDB), session, cart state
│   ├── api.ts                   # add inventoryApi + posApi calls
│   ├── FeaturesContext.tsx      # gate with hasFeature('inventory') / hasFeature('pos')
│   └── App.tsx                  # register /inventory and /pos routes (feature-gated)
└── src/__tests__/               # Vitest for terminal + mutation components
```

**Structure Decision**: Extend the existing `server/routes`, `server/services`, `client/src/pages` trees — no new packages or services. Two route namespaces (`/api/inventory`, `/api/pos`) each mounted in `server/index.ts` with `apiLimiter` and their `requireFeature` gate, mirroring how `agile`, `chat`, and `compensation` are wired.

## Integration Points (concrete)

1. **Feature flags** — in `server/utils/planCatalog.ts`:
   - Add to `FEATURE_LABELS`: `inventory: "Inventory Management"`, `pos: "Point of Sale"`.
   - Add per-plan defaults: `enterprise` → both `true`; `pro`/`standard` → both `false` (opt-in override supported).
   - Add dependency post-processing in `getEffectiveFeatures`: if `pos === true` but `inventory === false`, force `pos = false` (and surface in `planFeatureDiff`/dry-run).
2. **Backend gates** — each router: `router.use(requireTenant, requireFeature('inventory'|'pos'))` then `auth`, `loadUserContext`, `requireRole(...)`, mirroring `routes/agile.ts` and `routes/compensation.ts`.
3. **Frontend gates** — `useFeatures().hasFeature('inventory'|'pos')` to show/hide nav + routes; server remains the authoritative gate.
4. **Migrations** — append `2026_07_v20`…`v25` `{ name, up }` objects to `MIGRATIONS` in `migrationRunner.ts` (idempotent `CREATE TABLE/INDEX IF NOT EXISTS`), auto-swept per tenant on startup via `sweepAllTenants`.
5. **Route registration** — in `server/index.ts` add `app.use("/api/inventory", apiLimiter, inventoryRoutes)` and `app.use("/api/pos", apiLimiter, posRoutes)`.
6. **Real-time** — new WS events `stock.level.updated`, `pos.order.synced`, `pos.session.updated`, dispatched through existing `ws` utilities with `wsValidate` schemas + `wsIdempotency` keys + `wsMetrics` wrapping.
7. **Notifications** — `ReorderScheduler` and low-stock/variance events reuse the `notifications` system + email templates.
8. **Audit** — reuse `utils/audit.ts logAction` for every privileged write.
9. **Plan-gating test** — add `inventory` and `pos` rows to `planGating.test.ts`; the existing "every gateable feature has ≥1 requireFeature call" test will enforce wiring automatically.

## Phase 0: Research Plan  → see `research.md` (complete)

1. ✅ Market analysis of 10 OSS POS/inventory systems (licenses, stacks, maturity, data models).
2. ✅ Ranked reference systems for a Node/TS/PG multi-tenant SaaS (Medusa v2, Odoo, Vendure, ERPNext, Saleor).
3. ✅ Chosen data-model patterns (append-only ledger, denormalized balance, reservations, single-table movements, POS session lifecycle, multi-tender, structural locations, unified lot/serial, per-item valuation, idempotent offline sync).
4. ✅ Architecture decisions D1–D8 (feature-flag delivery, pos→inventory dependency, per-tenant migrations, money precision, `ws` reuse, offline-first, single-writer ValuationService, capability RBAC).
5. ✅ License hygiene (no GPL/LGPL source copied; MIT/BSD patterns only).

## Phase 1: Design Plan

1. ✅ Data model + migration grouping (`data-model.md`).
2. Define API contracts (`contracts/inventory-api.md`, `contracts/pos-api.md`) — endpoints, request/response shapes, WS event schemas, error cases.
3. Define `ValuationService` transition table (receipt/sale/return/adjustment/transfer/reversal × FIFO/AVCO/Standard) as the unit-test matrix.
4. Define the POS session state machine (`opening→open→closing→closed`, rescue path) and the idempotent offline-sync contract.
5. Produce `quickstart.md` (enable feature → seed catalog → receive stock → open session → sell → close → reconcile).
6. Re-check constitution gates post-design (expected pass).

## Phase 2: Implementation Sequencing (for `/speckit.tasks`)

Ordered by dependency; each phase independently testable:

1. **Inventory foundation** — migrations v20–v22, catalog + warehouse CRUD, `ValuationService` + `ReservationService`, stock ledger/levels read APIs. (US1)
2. **Inventory documents** — migration v23, purchasing/receipts/transfers/adjustments/reorder, wiring each posting to `ValuationService`. (US4)
3. **POS configuration** — migration v24, registers/payment-methods/tax/price-lists/discounts. (US2 setup)
4. **POS transactions** — migration v25, `PosSessionService` + `PosOrderService`, cart→sale decrementing stock via `ValuationService`, multi-tender, receipts. (US2)
5. **Offline + real-time** — IndexedDB queue, idempotent sync, WS stock/terminal events. (US3, SC-002/SC-003)
6. **Returns/refunds** — return orders + refund payments + restock + manager approval. (US5)
7. **Client UI** — inventory grids + POS terminal, feature-gated routes, Vitest coverage.
8. **Hardening** — plan-gating, audit, reconciliation-invariant tests (SC-001/004/006), docs (`ARCHITECTURE.md`, `API_DOCUMENTATION.md`, `README.md` feature list).

## Post-Design Constitution Re-Check

- [x] **I** — Design keeps every table/query `org_id`-scoped; no cross-tenant path.
- [x] **II** — All mutations RBAC-gated in middleware; sensitive actions require `manager`.
- [x] **III** — Single-writer `ValuationService`; idempotent sync; `ws` utilities enforced; audited transitions.
- [x] **IV** — Test matrix defined for valuation, session state machine, idempotency, plan-gating.
- [x] **V** — Structured log + audit row on every domain event specified in FR-X4.
- [x] **VI** — No new service/abstraction beyond `ValuationService` (multi-caller); returns reuse orders; deps minimized.
- [x] **VII** — Mobile POS explicitly out of scope for v1.

## Complexity Tracking

| Violation / Risk | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| New client dep `@zxing/browser` (barcode camera) | Camera-based scanning is a core retail POS expectation | Keyboard-wedge only would drop camera scanning entirely; ZXing is MIT and tree-shakeable, gated to the POS bundle |
| ~30 new tenant tables | Inventory + POS are genuinely large domains; ledger/valuation cannot be collapsed further without losing auditability | Fewer tables (e.g., JSON blobs for lines) rejected — breaks relational integrity, reporting, and the reconciliation invariant (SC-001) |
| `ValuationService` abstraction | Single-writer rule (Constitution III / ADR-0001); ≥4 callers (receipt, sale, transfer, adjustment) | Inline valuation in each route rejected — multiple uncoordinated writers to `stock_ledger` is exactly what the constitution forbids |
| Mobile POS deferred | Keeps v1 scope shippable; web terminal covers retail counter | Building mobile now would violate YAGNI (VI) and add Expo/native surface with no confirmed requirement |
