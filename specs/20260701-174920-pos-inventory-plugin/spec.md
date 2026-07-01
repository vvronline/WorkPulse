# Feature Specification: Point of Sale & Inventory Management Plugin

**Feature Branch**: `20260701-174920-pos-inventory-plugin`

**Created**: 2026-07-01

**Status**: Draft

**Input**: User description: "Implement a Point of Sale and Inventory management system into this project as a plugin. Analyse best open source available system in the market and create a rock solid enterprise grade implementation plan."

## Overview

Add two new plan-gated feature modules to WorkPulse:

- **Inventory Management** (`inventory`) — products & variants, warehouses & locations, an append-only stock ledger with denormalized balances, lots/serials, purchase orders & goods receipts, transfers, adjustments/stock-takes, reorder points, and FIFO/AVCO/Standard valuation.
- **Point of Sale** (`pos`) — registers, cash sessions/shifts with reconciliation, an offline-first sales terminal, multi-tender payments, refunds/returns, discounts, tax handling, barcode scanning, and receipts. POS sells *through* the inventory ledger.

Both ship as feature flags inside the existing plan/feature system — no new microservice. See `research.md` for the market analysis and architecture decisions.

## Clarifications

### Session 2026-07-01 (assumptions pending confirmation)

- Q: Scope of POS in v1? → A: **Retail POS only** (no restaurant tables/modifiers/KDS in v1).
- Q: Does POS require Inventory? → A: **Yes** — `pos` depends on `inventory`; a sale must move stock through the ledger.
- Q: Offline behavior for a register during a network blip? → A: **Offline-first** — queue sales locally, sync idempotently on reconnect; never double-post.
- Q: Valuation methods in v1? → A: **FIFO, AVCO (moving average), and Standard cost**, selectable per product.
- Q: Money precision? → A: `NUMERIC(14,4)` money, `NUMERIC(14,3)` quantities; a `currency` column per document; single tenant currency per register in v1.
- Q: Which plans get it? → A: Add-on capability; **Enterprise on by default**, opt-in override for Pro; Standard off. Fail-closed for all new tenants (Constitution VI).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Manage a product catalog & stock on hand (Priority: P1)

As an **inventory manager**, I can create products (with variants/SKUs/barcodes), define warehouses and locations, and see accurate on-hand / reserved / available quantities per location.

**Why this priority**: Nothing else (POS, purchasing, valuation) works without an accurate catalog and stock balance.

**Independent Test**: Create a product with two variants, receive 100 units into a warehouse location, and verify on-hand = 100, reserved = 0, available = 100, with a matching ledger entry.

**Acceptance Scenarios**:

1. **Given** the `inventory` feature is enabled, **When** a manager creates a product with a variant and barcode, **Then** it is retrievable by SKU and by barcode scoped to the tenant.
2. **Given** a warehouse with a hierarchy `Warehouse > Zone > Bin`, **When** stock is received into a leaf bin, **Then** on-hand reflects the receipt and a `stock_ledger` row records `qty_after_transaction` and `valuation_rate`.
3. **Given** a Standard-plan tenant without the feature, **When** it calls any `/api/inventory/*` endpoint, **Then** the server returns 403 (feature gate) regardless of the UI.

---

### User Story 2 — Sell at a register and reconcile the till (Priority: P1)

As a **cashier**, I can open a cash session on a register, scan/add products to a cart, accept split payments, print a receipt, and close the session with a counted-cash reconciliation showing over/short.

**Why this priority**: This is the core POS transaction and the cash-audit trail.

**Independent Test**: Open a session with a $100 float, sell 3 items paid $40 cash + rest card, then close counting cash; verify expected vs counted variance and that stock decremented via the ledger.

**Acceptance Scenarios**:

1. **Given** an open session, **When** the cashier completes a sale of qty 2, **Then** a paid `pos_order` is created, two `pos_payment` rows exist for split tender, and inventory available drops by 2 via a `SALE` stock movement.
2. **Given** a sale that overpays in cash, **When** payment is finalized, **Then** an `is_change` payment row records the change tendered and `amount_return` is correct.
3. **Given** an open session, **When** the cashier closes it counting cash, **Then** `closing_expected`, `closing_counted`, and `variance` are recorded and the session becomes `closed` (immutable).
4. **Given** two registers selling the last unit concurrently, **When** both finalize, **Then** exactly one succeeds and the other is rejected as out-of-stock (no negative available unless overselling is explicitly allowed).

---

### User Story 3 — Offline sale survives a network drop (Priority: P2)

As a **cashier**, I can keep selling when the network drops, and my queued sales sync exactly once when connectivity returns.

**Why this priority**: A register that stops on a blip is unusable in retail.

**Independent Test**: Disconnect the terminal, complete two sales, reconnect; verify both sales appear once server-side with correct stock decrements and no duplicates.

**Acceptance Scenarios**:

1. **Given** the terminal is offline, **When** a sale is completed, **Then** it is queued locally with a client UUID and the UI confirms provisionally.
2. **Given** queued offline sales, **When** the terminal reconnects, **Then** each syncs idempotently keyed by `(session_id, client_order_uuid)` — re-delivery produces no duplicate order or double stock decrement.
3. **Given** a sale referencing a session that was already closed (rescue), **When** it syncs, **Then** it is attached to a rescue session and flagged for manager review, not silently dropped.

---

### User Story 4 — Purchase, receive, adjust, transfer, and re-order (Priority: P2)

As an **inventory manager**, I can raise a purchase order, receive goods (updating cost basis), run a stock-take adjustment, transfer stock between locations, and get reorder alerts when stock falls below the reorder point.

**Independent Test**: PO for 50 @ $10, receive 50, verify AVCO cost and on-hand; count 48 in a stock-take, verify a −2 adjustment ledger entry and updated balance; transfer 10 to another location.

**Acceptance Scenarios**:

1. **Given** a submitted PO, **When** a goods receipt is posted, **Then** on-hand and valuation update and `incoming_quantity` decreases accordingly.
2. **Given** a stock-take with counted ≠ system quantity, **When** posted, **Then** a signed adjustment `stock_ledger` entry reconciles the balance and is attributed to the user (audit row).
3. **Given** a transfer between two locations, **When** posted, **Then** source available decreases and destination on-hand increases with two linked ledger movements.
4. **Given** a variant below its reorder level, **When** the reorder sweep runs, **Then** a reorder alert/notification is raised for that warehouse.

---

### User Story 5 — Refund/return a sale (Priority: P2)

As a **cashier/manager**, I can process a full or partial return against an existing sale, restock the items, and refund by a chosen tender — with manager approval where required.

**Acceptance Scenarios**:

1. **Given** a paid order, **When** a partial return of qty 1 is processed, **Then** a linked return order with negative quantity is created, stock is restocked via a `RETURN` movement, and a refund payment is recorded.
2. **Given** a return above a configured threshold, **When** submitted by a cashier, **Then** it requires manager approval before completing.

---

### Edge Cases

- Concurrent last-unit sale on two registers (oversell guard / reservation race).
- Duplicate offline-sync delivery or app reload mid-sync (idempotency).
- Sale referencing an already-closed session (rescue session).
- Negative stock when overselling is disabled vs allowed (per-product policy).
- Valuation when receiving at a different cost than prior layers (FIFO queue / AVCO recompute).
- Lot/serial required but not supplied at receipt or sale.
- Tax rounding at line vs order level; inclusive vs exclusive pricing.
- Refund exceeding original quantity/amount (must be rejected).
- Feature disabled mid-shift (in-flight session must close gracefully).
- Barcode collision across two variants in the same tenant.

## Requirements *(mandatory)*

### Functional Requirements — Inventory

- **FR-I1**: System MUST let managers create products, variants (SKU, barcodes, UoM, attributes), and categories, all scoped to the tenant/org.
- **FR-I2**: System MUST model warehouses and a hierarchical location tree; only leaf/non-structural locations may hold stock.
- **FR-I3**: System MUST maintain an **append-only** `stock_ledger` (immutable) recording every movement with signed quantity, running balance, and valuation rate; ledger rows MUST never be updated, only appended/reversed.
- **FR-I4**: System MUST maintain a denormalized `stock_levels` balance per `(variant, location, lot)` with `on_hand`, `reserved`, `incoming`, reconciled from the ledger.
- **FR-I5**: System MUST support lot and serial tracking selectable per product (`tracking_type: none|lot|serial`), with optional expiry (FEFO).
- **FR-I6**: System MUST support purchase orders, goods receipts (updating cost basis and `incoming`), transfers, and adjustments/stock-takes; each posting MUST write ledger + audit rows.
- **FR-I7**: System MUST support per-product valuation methods **FIFO, AVCO, Standard**, with an auditable cost basis per movement.
- **FR-I8**: System MUST support reorder points per variant/warehouse and raise reorder alerts via the existing notifications system.
- **FR-I9**: All inventory write mutations MUST flow through a single `ValuationService` writer; no other code path may write `stock_ledger`/`stock_levels`.

### Functional Requirements — POS

- **FR-P1**: System MUST support registers (POS configs) with assigned payment methods, price list, tax regime, and stock source location.
- **FR-P2**: System MUST support a cash-session lifecycle `opening → open → closing → closed` with opening float, cash in/out, expected vs counted close, and recorded variance; a closed session is immutable.
- **FR-P3**: System MUST support carts/orders with lines, per-line discount and tax, and order-level totals (subtotal, tax, total, paid, change).
- **FR-P4**: System MUST support multi-tender payments (N payment rows per order, including an `is_change` row) and per-method reconciliation.
- **FR-P5**: A completed sale MUST reserve then decrement inventory through the ledger (`SALE` movement); oversell is rejected unless the product allows negative stock.
- **FR-P6**: System MUST support refunds/returns linked to the original order (`RETURN` movement restocks) with optional manager approval above a threshold.
- **FR-P7**: The terminal MUST be **offline-first**: queue sales with client UUIDs and sync idempotently keyed by `(session_id, client_order_uuid)`; re-delivery MUST NOT duplicate orders or stock moves.
- **FR-P8**: System MUST support barcode lookup by variant barcode (keyboard-wedge + camera) and receipt generation (HTML/ESC-POS) with a per-register template.
- **FR-P9**: System MUST support configurable taxes (inclusive/exclusive, per product/category) and line- and order-level discounts, including manager-authorized override discounts.

### Functional Requirements — Platform integration (cross-cutting)

- **FR-X1**: `inventory` and `pos` MUST be plan-gated feature flags in `planCatalog.ts`, defaulting **off** for new tenants (fail-closed), enforced server-side with `requireFeature` and client-side with `hasFeature`.
- **FR-X2**: Enabling `pos` MUST require `inventory` (dependency enforced in effective-feature resolution and the plan-change dry-run).
- **FR-X3**: Every data query MUST be tenant/org-scoped; no client-supplied tenant/org override may bypass session-derived scope (Constitution I).
- **FR-X4**: All write actions and every stock movement, session open/close, void, refund, and discount override MUST emit a structured Pino log and an audit row (Constitution V).
- **FR-X5**: Real-time stock-level and cross-terminal events MUST use the existing `ws` server wrapped with `wsValidate` + `wsIdempotency` + `wsMetrics` (Constitution III); no new socket channel.
- **FR-X6**: New routes MUST have Jest+Supertest happy-path + primary-error tests; the `ValuationService` and POS session state machine MUST have per-transition unit tests; data-mutation client components MUST have Vitest tests (Constitution IV).
- **FR-X7**: Money MUST be `NUMERIC(14,4)` with an explicit currency; quantities `NUMERIC(14,3)`; no float money.
- **FR-X8**: New tenant tables MUST be delivered as additive, idempotent migrations appended to `migrationRunner.ts` and swept per tenant DB.

### Key Entities *(data involves storage)*

See `data-model.md` for full schemas. Inventory: `product_categories`, `products`, `product_variants`, `variant_barcodes`, `uoms`, `warehouses`, `stock_locations`, `stock_lots`, `stock_ledger`, `stock_levels`, `stock_reservations`, `purchase_orders(+lines)`, `goods_receipts(+lines)`, `stock_transfers(+lines)`, `stock_adjustments(+lines)`, `reorder_rules`. POS: `pos_registers`, `pos_payment_methods`, `pos_sessions`, `pos_orders(+lines)`, `pos_payments`, `pos_returns(+lines)`, `pos_receipts`, `tax_rates`, `price_lists(+items)`, `discounts`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On-hand computed from the append-only ledger MUST equal the denormalized `stock_levels` balance for 100% of variants after any sequence of postings (reconciliation invariant, verified by test).
- **SC-002**: 0 duplicate orders and 0 double stock decrements across ≥1,000 simulated re-delivered/offline-synced sales (idempotency).
- **SC-003**: A completed in-store sale reflects the stock decrement across other terminals within ≤3s over WebSocket.
- **SC-004**: Cash-session close variance equals `counted − expected` exactly for every reconciliation test case (money invariant, no float drift).
- **SC-005**: 100% of `/api/inventory/*` and `/api/pos/*` write endpoints return 403 for tenants without the feature, and are covered by the plan-gating test.
- **SC-006**: Valuation (FIFO/AVCO/Standard) COGS matches hand-computed expected values for the golden-path test fixtures within ±0.0001.

## Assumptions

- Retail POS only in v1; restaurant mode (tables/modifiers/KDS), full GL/double-entry accounting, deep IoT hardware proxy, and multi-currency-per-register are explicitly deferred.
- Browser-based barcode input (USB HID + camera) and browser receipt printing are sufficient for v1.
- The existing multi-tenant DB-per-tenant model, `notifications`, `audit`, `ws`, and `requireFeature` infrastructure are reused as-is.
- Reference systems inform design only; no GPL/LGPL source is copied (see `research.md` §1 license hygiene).
