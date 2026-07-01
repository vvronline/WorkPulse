# Research: Open-Source POS & Inventory Systems + Architecture Decisions

**Feature**: POS & Inventory Management Plugin
**Branch**: `20260701-174920-pos-inventory-plugin`
**Date**: 2026-07-01
**Purpose**: Phase 0 research for the POS/Inventory plugin — market analysis of the best open-source systems and the data-model / architecture decisions derived from them.

---

## 1. Market Analysis — Best Open-Source POS & Inventory Systems

All GitHub statistics verified live via the GitHub API on 2026-07-01. Entity models were traced from actual source files, not just documentation.

| System | Stars | License | Stack | DB | POS | Inventory | Multi-tenant model |
|---|---|---|---|---|---|---|---|
| **Odoo 19 (Community)** | 52.7k | LGPLv3¹ | Python / Owl | PostgreSQL | ✅ Full | ✅ Full | `company_id` |
| **ERPNext / Frappe** | 36.4k | GPLv3 | Python / Frappe | MariaDB | ✅ | ✅ Full | `company` |
| **Medusa v2** | 34.8k | **MIT** | **Node / TypeScript** | **PostgreSQL** | ⚠️ via modules | ✅ Module | channels / modules |
| **Bagisto** | 27.6k | MIT | PHP / Laravel | MySQL/PG | ❌ | ✅ | channels |
| **Saleor** | 23.0k | BSD-3 | Python / Django | PostgreSQL | ❌ | ✅ multi-WH | channels |
| **Grocy** | 9.2k | MIT | PHP | SQLite | ❌ | ⚠️ household | none |
| **Vendure** | 8.2k | GPLv3 + plugin exception | **Node / NestJS / TS** | **PostgreSQL** | ❌ | ✅ multi-loc | channels |
| **InvenTree** | 7.2k | MIT | Python / Django | SQLite/PG | ❌ | ✅ deep | none |
| **uniCenta / Chromis** | <1k | GPLv3 | Java (Swing) | MySQL | ✅ desktop | ⚠️ basic | none |
| **Floreant POS** | <500 | LGPL | Java (Swing) | MySQL | ✅ restaurant | ❌ | none |

¹ Odoo Community modules are LGPLv3; some Odoo Enterprise modules are proprietary. Always check each module's `__manifest__.py` `license` key.

### Per-system takeaways

- **Odoo (Community)** — the single deepest reference for *both* POS and inventory. Multi-step warehouse routing, FIFO/AVCO/Standard valuation, `stock.quant` balance + `stock.move` ledger, and a full `pos.session` cash-control lifecycle with browser offline mode. Python, but the domain model is the canonical teacher.
- **ERPNext** — best reference for **inventory accounting**: `Stock Ledger Entry` is a pure append-only immutable journal with `qty_after_transaction` (running balance), `valuation_rate`, `stock_value`, and a `stock_queue` JSON for FIFO. Per-item `valuation_method` (FIFO / Moving Average / LIFO / Standard).
- **Medusa v2** — **identical stack (Node/TS/PostgreSQL), MIT license.** Cleanest modern inventory primitive: `InventoryItem` + `InventoryLevel { stocked_quantity, reserved_quantity, incoming_quantity }` + `ReservationItem`. Directly adoptable patterns.
- **Vendure** — same TS stack; GPLv3 **with a plugin exception** (plugins may be any license). `StockMovement` is a single-table-inheritance base with a `type` discriminator (Sale/Cancellation/Return/Adjustment/Purchase/Initial) — a simpler alternative to six separate tables. Channel-aware `StockLevel`.
- **Saleor** — BSD-3; first-class `Allocation` and `Reservation` entities, channel- and country-aware stock. Good model for "available = quantity − allocated".
- **InvenTree** — best pure-inventory part tracking: MPTT hierarchical `StockLocation`, `structural` container-only locations, per-`StockItem` serial/batch/expiry/purchase price. Not a POS.
- **Grocy** — household FMCG only; useful FEFO (first-expiry-first-out) and min-stock shopping-list ideas.
- **uniCenta / Floreant** — legacy Java desktop, stalled. Not architecturally relevant, but Floreant's **restaurant vocabulary** (ticket, modifier group, table, floor, void, comp, KDS) is the canonical reference *if* restaurant mode is ever in scope.

### Decision — reference systems (ranked)

1. **Medusa v2** (MIT, Node/TS/PG) — inventory primitives (`InventoryLevel`, `ReservationItem`), workflow/saga compensation pattern. **Closest to WorkPulse's stack.**
2. **Odoo 17/19 Community** (LGPLv3) — POS session lifecycle + cash control, warehouse/location tree, valuation. Domain reference only (no code copied).
3. **Vendure** (GPLv3 + plugin exception) — single-table `stock_movements` discriminator, order state machine, channel-aware stock. TypeScript patterns.
4. **ERPNext** (GPLv3) — append-only Stock Ledger Entry + per-item valuation methods.
5. **Saleor** (BSD-3) — Allocation/Reservation availability math.

> **License hygiene**: WorkPulse is a proprietary SaaS. We will **not** copy GPL/LGPL code (Odoo, ERPNext, Vendure core, uniCenta, Floreant). We take **design patterns and vocabulary** from those, and may reuse **MIT/BSD** code (Medusa, Saleor, InvenTree, Grocy, Bagisto) with attribution if ever needed. No source is vendored in this plan — the schema and services are original implementations of well-understood patterns.

---

## 2. Data-Model Patterns Adopted

| # | Pattern | Source | Why we adopt it |
|---|---|---|---|
| 1 | **Append-only stock ledger** with `qty_after_transaction` running balance + `valuation_rate` + `stock_value` | ERPNext `StockLedgerEntry` | Immutable audit trail (Constitution V); O(1) current-balance reads; FIFO/AVCO valuation trail |
| 2 | **Denormalized balance table** `(variant, location, lot)` = `on_hand / reserved / incoming` | Medusa `InventoryLevel` + Odoo `stock.quant` | Fast availability queries without scanning the ledger; reconciled from ledger |
| 3 | **Reservation / allocation** entity separate from ledger | Medusa `ReservationItem` / Saleor `Allocation` | POS placing an order reserves stock; fulfillment converts reservation → ledger entry; prevents oversell |
| 4 | **Single-table stock movements** with a `movement_type` discriminator | Vendure `StockMovement` | One table, type-safe, simpler than six tables |
| 5 | **POS session lifecycle** `opening → open → closing → closed` with `opening_float`, `closing_counted`, `closing_expected`, `variance` | Odoo `pos.session` | Cash reconciliation, over/short tracking, shift audit |
| 6 | **Multi-tender payments** — N payment rows per order, `is_change` row for change | Odoo `pos.payment` | Split cash+card, change tender, gateway metadata |
| 7 | **Hierarchical structural locations** (`warehouse > zone > aisle > bin`), container-only leaves | InvenTree `StockLocation.structural` (via Postgres `ltree`/parent FK) | Clean warehouse topology; only leaf locations hold stock |
| 8 | **Unified lot/serial** entity, `tracking_type: none\|lot\|serial` on the variant | Odoo `stock.lot` | One code path for batch and serial; serial = lot of qty 1 |
| 9 | **Per-item valuation method** FIFO / AVCO / Standard, `stock_queue` JSON for FIFO | ERPNext `Item.valuation_method` | Accurate COGS; auditable cost basis per movement |
| 10 | **Idempotent offline sync** — client UUID + `access_token` per order, server dedupes | Odoo POS offline / WorkPulse `wsIdempotency` | Terminal offline-first; reconnection never double-posts a sale (Constitution III) |

---

## 3. Architecture Decisions (WorkPulse-specific)

### D1 — Plugin delivery = feature flag, not a separate service
**Decision**: Ship POS and Inventory as two new **feature flags** (`inventory`, `pos`) inside the existing `planCatalog.ts` + `requireFeature`/`hasFeature` mechanism, with routes/tables/UI living in the current `server/` and `client/` trees.
**Rationale**: The codebase already has a first-class plugin/feature system (agile, chat, payroll, custom_fields are all "plugins" this way). Constitution VI (Simplicity) forbids a new abstraction/service used by one caller. A microservice would violate the multi-tenant DB-per-tenant model and add ops complexity for zero benefit.
**Rejected**: standalone microservice; embedding Medusa/Vendure as a dependency (bundle size, GPL for Vendure core, dual-ORM conflict with `pg`).

### D2 — `inventory` is a dependency of `pos`
**Decision**: `pos` requires `inventory` to be enabled (POS decrements stock through the inventory ledger). Enforced in `getEffectiveFeatures` post-processing and surfaced in the plan-change dry-run.
**Rationale**: A sale must move stock; a POS without an inventory ledger silently loses valuation and audit.

### D3 — Storage = per-tenant tables via the additive migration registry
**Decision**: All new tables are tenant-scoped and created by appending idempotent `{ name, up }` migrations to `server/utils/migrationRunner.ts` (`MIGRATIONS`), swept per tenant DB on startup (`sweepAllTenants`). Naming: `2026_07_v20_inventory_foundation`, `2026_07_v21_pos_foundation`, etc.
**Rationale**: Matches the exact mechanism every existing feature uses; Constitution "additive migrations" rule; DB-per-tenant isolation is automatic (no `tenant_id` column needed — the tenant *is* the database, scoped by `org_id` within it, mirroring existing tables like `custom_field_definitions`).

### D4 — Money & quantities
**Decision**: Money stored as `NUMERIC(14,4)` (4 dp) with an explicit `currency` column per document; quantities `NUMERIC(14,3)`. No floats for money.
**Rationale**: Avoids float rounding in valuation/tax; matches finance-grade requirements.

### D5 — Real-time stock + terminal sync uses the existing `ws` stack
**Decision**: Stock-level changes and cross-terminal POS events broadcast over the existing native `ws` server, wrapped with `wsValidate` (schema), `wsIdempotency` (dedupe), and `wsMetrics` (timing) per Constitution III. No new socket channel.
**Rationale**: Constitution locks `ws`; reuse the hardened idempotency/validation utilities.

### D6 — POS terminal is offline-first
**Decision**: The web POS terminal caches catalog/tax/customer data (IndexedDB) on session open, queues sales locally with client-generated UUIDs, and syncs idempotently on reconnect. Server dedupes by `(session_id, client_order_uuid)`.
**Rationale**: A register must keep selling through a network blip (industry baseline; Odoo pattern). Idempotent sync satisfies Constitution III.

### D7 — Valuation engine is a single-responsibility service
**Decision**: One `ValuationService` owns every write to the stock ledger + balance table (no other writer touches `stock_ledger` / `stock_levels`), mirroring the `StatusService` single-writer rule (ADR-0001).
**Rationale**: Constitution III forbids multiple uncoordinated writers to the same state; valuation math (FIFO queue, AVCO recompute) must be centralized and unit-tested per transition.

### D8 — RBAC via capabilities on top of existing roles
**Decision**: Reuse existing roles; gate write actions with `requireRole('manager')` for configuration (products, warehouses, price lists, void/refund approvals) and allow `employee`+ to operate a register only when assigned to it. Add two tenant-configurable role presets (`inventory_manager`, `pos_cashier`) to `DEFAULT_TENANT_ROLES` documentation, but do not hard-code new role levels.
**Rationale**: Constitution VI (no speculative abstraction); the RBAC system is already tenant-customizable.

---

## 4. Open Questions Resolved (assumptions)

- **Restaurant mode (tables/modifiers/KDS)** — **out of scope** for v1 (retail POS only). Floreant vocabulary noted for a future phase.
- **Accounting/GL postings** — v1 emits inventory valuation + a POS cash-session summary; full double-entry GL integration is a later phase (WorkPulse has no GL module today).
- **Hardware** (cash drawer, receipt printer, scale) — v1 targets browser-based barcode input (USB HID keyboard-wedge + camera scan) and HTML/ESC-POS receipt printing via the browser; deep IoT hardware proxy is out of scope.
- **Multi-currency** — single tenant currency per POS config in v1; the schema carries a `currency` column so multi-currency is additive later.
- **Tax engine** — configurable tax rates (inclusive/exclusive) per product/category; jurisdiction/fiscal-position mapping is a later phase.

---

## 5. Citations

- GitHub API: `odoo/odoo`, `frappe/erpnext`, `medusajs/medusa`, `vendurehq/vendure`, `saleor/saleor`, `inventree/InvenTree`, `grocy/grocy`, `bagisto/bagisto` (stars, license, push dates, 2026-07-01)
- `odoo/odoo:addons/stock/models/{stock_move,stock_quant,stock_warehouse,stock_lot}.py`
- `odoo/odoo:addons/point_of_sale/models/{pos_session,pos_order,pos_payment}.py`
- `frappe/erpnext:erpnext/stock/doctype/stock_ledger_entry/stock_ledger_entry.py`
- `frappe/erpnext:erpnext/stock/doctype/item/item.py`
- `vendurehq/vendure:packages/core/src/entity/{stock-location,stock-movement,product-variant,order,payment}/*.entity.ts`
- `saleor/saleor:saleor/warehouse/models.py`
- `inventree/InvenTree:src/backend/InvenTree/stock/models.py`
- `https://docs.medusajs.com/resources/commerce-modules/inventory/concepts`
- `https://docs.medusajs.com/resources/commerce-modules/stock-location`
- Vendure plugin exception: `https://github.com/vendurehq/vendure/blob/master/license/plugin-exception.txt`
