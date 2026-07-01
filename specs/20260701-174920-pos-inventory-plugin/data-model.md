# Data Model: POS & Inventory Plugin

**Feature**: `20260701-174920-pos-inventory-plugin`
**Date**: 2026-07-01

All tables are **tenant-scoped** (created inside each tenant DB by the additive migration registry — see `plan.md`). They follow existing WorkPulse conventions observed in `db.ts` / `migrationRunner.ts`:

- `id SERIAL PRIMARY KEY`, `org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`
- `created_by INTEGER REFERENCES users(id) ON DELETE SET NULL`, `created_at/updated_at TIMESTAMPTZ DEFAULT NOW()`
- Money `NUMERIC(14,4)`, quantities `NUMERIC(14,3)`, `currency CHAR(3)` per document
- `CHECK` constraints for enums; `JSONB` for flexible attributes; `UNIQUE(org_id, ...)` for tenant-local keys
- Indexes on every FK used in hot queries

Isolation note: because WorkPulse uses **DB-per-tenant**, cross-tenant leakage is prevented by the request-scoped pool (`req.db`). `org_id` scopes within a tenant that may host multiple organizations, matching existing tables like `custom_field_definitions`.

---

## Part A — Inventory

### A1. Catalog

```
uoms                      -- units of measure
  id, org_id, name, code, category ('unit'|'weight'|'volume'|'length'|'time'),
  ratio_to_base NUMERIC(14,6) DEFAULT 1,   -- conversion to category base unit
  is_base BOOLEAN, is_active BOOLEAN, created_at, updated_at
  UNIQUE(org_id, code)

product_categories
  id, org_id, name, parent_id REFERENCES product_categories(id) ON DELETE SET NULL,
  default_tax_rate_id, sort_order, is_active, created_at, updated_at
  UNIQUE(org_id, name, parent_id)

products                  -- template
  id, org_id, name, description, category_id REFERENCES product_categories(id) ON DELETE SET NULL,
  brand, type ('stockable'|'consumable'|'service') DEFAULT 'stockable',
  tracking_type ('none'|'lot'|'serial') DEFAULT 'none',
  valuation_method ('fifo'|'avco'|'standard') DEFAULT 'avco',
  base_uom_id REFERENCES uoms(id),
  allow_negative_stock BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE, attributes JSONB DEFAULT '{}',
  created_by, created_at, updated_at
  INDEX(org_id, is_active)

product_variants          -- SKU
  id, org_id, product_id REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL, name TEXT,
  attributes JSONB DEFAULT '{}',           -- {size, color, ...}
  cost_price NUMERIC(14,4) DEFAULT 0,      -- current standard/avg cost
  sale_price NUMERIC(14,4) DEFAULT 0,
  weight NUMERIC(14,3), weight_uom_id,
  reorder_managed BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at, updated_at
  UNIQUE(org_id, sku)
  INDEX(org_id, product_id)

variant_barcodes
  id, org_id, variant_id REFERENCES product_variants(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL, barcode_type ('EAN13'|'EAN8'|'UPCA'|'CODE128'|'QR'|'OTHER') DEFAULT 'EAN13',
  UNIQUE(org_id, barcode)                  -- barcode unique per tenant (edge case guard)
```

### A2. Warehouses & locations (hierarchical, structural)

```
warehouses
  id, org_id, name, code TEXT, address JSONB, is_active BOOLEAN DEFAULT TRUE,
  created_at, updated_at
  UNIQUE(org_id, code)

stock_locations           -- tree; only leaf/non-structural hold stock
  id, org_id, warehouse_id REFERENCES warehouses(id) ON DELETE CASCADE,
  parent_id REFERENCES stock_locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, code TEXT,
  usage ('internal'|'supplier'|'customer'|'transit'|'inventory'|'scrap') DEFAULT 'internal',
  structural BOOLEAN DEFAULT FALSE,        -- container-only; cannot hold stock directly
  path LTREE,                              -- materialized path for subtree queries (optional; parent_id is source of truth)
  is_active BOOLEAN DEFAULT TRUE, created_at, updated_at
  INDEX(org_id, warehouse_id), INDEX(org_id, parent_id)
```

### A3. Lots / serials

```
stock_lots                -- unified lot & serial (serial = lot of qty 1)
  id, org_id, variant_id REFERENCES product_variants(id) ON DELETE CASCADE,
  lot_code TEXT NOT NULL,                  -- lot number or serial number
  kind ('lot'|'serial') NOT NULL,
  expiry_date DATE, manufactured_date DATE,
  supplier_id, properties JSONB DEFAULT '{}',
  created_at
  UNIQUE(org_id, variant_id, lot_code)
```

### A4. Ledger + balance + reservations (the core)

```
stock_ledger              -- APPEND-ONLY, immutable audit journal (ERPNext pattern)
  id BIGSERIAL PRIMARY KEY, org_id,
  variant_id REFERENCES product_variants(id),
  location_id REFERENCES stock_locations(id),
  lot_id REFERENCES stock_lots(id),        -- nullable
  movement_type ('receipt'|'sale'|'return'|'adjustment'|'transfer_in'|'transfer_out'|'initial'|'reservation_release'|'reversal'),
  source_doc_type TEXT,                     -- 'goods_receipt'|'pos_order'|'stock_adjustment'|'stock_transfer'|...
  source_doc_id INTEGER, source_line_id INTEGER,
  qty NUMERIC(14,3) NOT NULL,              -- signed: +in / -out
  qty_after NUMERIC(14,3) NOT NULL,        -- running balance for (variant,location,lot)
  incoming_rate NUMERIC(14,4), outgoing_rate NUMERIC(14,4),
  valuation_rate NUMERIC(14,4),            -- unit cost basis after this move
  stock_value NUMERIC(16,4),               -- total value after
  stock_value_diff NUMERIC(16,4),
  fifo_queue JSONB,                         -- [[qty, rate], ...] snapshot for FIFO products
  currency CHAR(3) DEFAULT 'USD',
  posted_at TIMESTAMPTZ DEFAULT NOW(),
  posted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_reversed BOOLEAN DEFAULT FALSE, reversed_by_id BIGINT
  INDEX(org_id, variant_id, location_id, posted_at),
  INDEX(org_id, source_doc_type, source_doc_id)
  -- NOTE: rows are never UPDATEd except to set is_reversed/reversed_by_id; corrections append a 'reversal'.

stock_levels              -- denormalized balance (Medusa InventoryLevel + Odoo quant)
  id, org_id,
  variant_id REFERENCES product_variants(id) ON DELETE CASCADE,
  location_id REFERENCES stock_locations(id) ON DELETE CASCADE,
  lot_id REFERENCES stock_lots(id) ON DELETE CASCADE,   -- nullable
  on_hand NUMERIC(14,3) DEFAULT 0,
  reserved NUMERIC(14,3) DEFAULT 0,
  incoming NUMERIC(14,3) DEFAULT 0,        -- open PO qty in transit
  -- available (generated): on_hand - reserved
  available NUMERIC(14,3) GENERATED ALWAYS AS (on_hand - reserved) STORED,
  avg_cost NUMERIC(14,4) DEFAULT 0,        -- for AVCO
  updated_at TIMESTAMPTZ DEFAULT NOW()
  UNIQUE(org_id, variant_id, location_id, COALESCE(lot_id, 0))
  INDEX(org_id, variant_id)

stock_reservations        -- soft holds (Medusa ReservationItem / Saleor Allocation)
  id, org_id, variant_id, location_id, lot_id,
  qty NUMERIC(14,3) NOT NULL,
  source_doc_type TEXT, source_doc_id INTEGER,   -- e.g. 'pos_order', <id>
  status ('held'|'fulfilled'|'released') DEFAULT 'held',
  expires_at TIMESTAMPTZ, created_at
  INDEX(org_id, variant_id, location_id, status)
```

**Invariant (SC-001)**: for every `(variant, location, lot)`, `stock_levels.on_hand` = latest `stock_ledger.qty_after`. Enforced by `ValuationService` and asserted in tests.

### A5. Documents (purchasing / movements)

```
suppliers
  id, org_id, name, contact JSONB, is_active, created_at, updated_at
  UNIQUE(org_id, name)

purchase_orders
  id, org_id, po_number TEXT, supplier_id REFERENCES suppliers(id),
  warehouse_id, status ('draft'|'submitted'|'partial'|'received'|'cancelled') DEFAULT 'draft',
  order_date DATE, expected_date DATE, currency CHAR(3),
  subtotal NUMERIC(16,4), tax_total NUMERIC(16,4), total NUMERIC(16,4),
  notes, created_by, created_at, updated_at
  UNIQUE(org_id, po_number)

purchase_order_lines
  id, org_id, po_id REFERENCES purchase_orders(id) ON DELETE CASCADE,
  variant_id, ordered_qty, received_qty DEFAULT 0, unit_cost NUMERIC(14,4),
  tax_rate_id, lot_id
  INDEX(org_id, po_id)

goods_receipts
  id, org_id, gr_number TEXT, po_id REFERENCES purchase_orders(id) ON DELETE SET NULL,
  warehouse_id, location_id, status ('draft'|'posted'|'cancelled') DEFAULT 'draft',
  received_date DATE, created_by, created_at
  UNIQUE(org_id, gr_number)

goods_receipt_lines
  id, org_id, gr_id REFERENCES goods_receipts(id) ON DELETE CASCADE,
  po_line_id, variant_id, received_qty, unit_cost, lot_id
  -- posting => ValuationService appends stock_ledger 'receipt' + updates stock_levels

stock_transfers
  id, org_id, transfer_number TEXT, source_location_id, dest_location_id,
  status ('draft'|'in_transit'|'done'|'cancelled') DEFAULT 'draft',
  transfer_date DATE, created_by, created_at
  UNIQUE(org_id, transfer_number)

stock_transfer_lines
  id, org_id, transfer_id REFERENCES stock_transfers(id) ON DELETE CASCADE,
  variant_id, lot_id, qty
  -- posting => two linked ledger rows: 'transfer_out' @source, 'transfer_in' @dest

stock_adjustments         -- stock-take / manual correction
  id, org_id, adjustment_number TEXT, warehouse_id, location_id,
  reason TEXT, status ('draft'|'posted'|'cancelled') DEFAULT 'draft',
  adjustment_date DATE, created_by, created_at
  UNIQUE(org_id, adjustment_number)

stock_adjustment_lines
  id, org_id, adjustment_id REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  variant_id, lot_id, counted_qty, system_qty, difference_qty
  -- posting => signed 'adjustment' ledger row

reorder_rules
  id, org_id, variant_id, warehouse_id,
  reorder_level NUMERIC(14,3), reorder_qty NUMERIC(14,3),
  is_active BOOLEAN DEFAULT TRUE, last_alerted_at TIMESTAMPTZ
  UNIQUE(org_id, variant_id, warehouse_id)
```

---

## Part B — Point of Sale

### B1. Configuration

```
tax_rates
  id, org_id, name TEXT, code TEXT, rate NUMERIC(9,4),   -- percent
  is_inclusive BOOLEAN DEFAULT FALSE, applies_to ('all'|'category'|'product') DEFAULT 'all',
  is_active BOOLEAN DEFAULT TRUE, created_at
  UNIQUE(org_id, code)

price_lists
  id, org_id, name, currency CHAR(3), is_default BOOLEAN DEFAULT FALSE, is_active,
  created_at, updated_at
  UNIQUE(org_id, name)

price_list_items
  id, org_id, price_list_id REFERENCES price_lists(id) ON DELETE CASCADE,
  variant_id, price NUMERIC(14,4), min_qty NUMERIC(14,3) DEFAULT 1
  UNIQUE(org_id, price_list_id, variant_id, min_qty)

discounts
  id, org_id, name, type ('percentage'|'fixed'|'free_item'), scope ('line'|'order'),
  value NUMERIC(14,4), coupon_code TEXT, requires_manager BOOLEAN DEFAULT FALSE,
  active_from DATE, active_to DATE, is_active BOOLEAN DEFAULT TRUE
  UNIQUE(org_id, coupon_code)

pos_payment_methods
  id, org_id, name, type ('cash'|'card'|'bank'|'wallet'|'pay_later'),
  is_cash_count BOOLEAN DEFAULT FALSE,     -- counted in till reconciliation
  is_active BOOLEAN DEFAULT TRUE
  UNIQUE(org_id, name)

pos_registers             -- one per physical till (Odoo pos.config)
  id, org_id, name, warehouse_id, stock_location_id,
  price_list_id, default_tax_rate_id, currency CHAR(3) DEFAULT 'USD',
  cash_control BOOLEAN DEFAULT TRUE,
  receipt_header TEXT, receipt_footer TEXT, receipt_show_logo BOOLEAN DEFAULT TRUE,
  payment_method_ids JSONB DEFAULT '[]',   -- allowed method ids
  is_active BOOLEAN DEFAULT TRUE, created_at, updated_at
  UNIQUE(org_id, name)
```

### B2. Sessions & orders

```
pos_sessions              -- cash shift (Odoo pos.session)
  id, org_id, register_id REFERENCES pos_registers(id),
  cashier_id REFERENCES users(id),
  state ('opening'|'open'|'closing'|'closed') DEFAULT 'opening',
  opened_at TIMESTAMPTZ, closed_at TIMESTAMPTZ,
  opening_float NUMERIC(14,4) DEFAULT 0,
  closing_expected NUMERIC(14,4), closing_counted NUMERIC(14,4),
  variance NUMERIC(14,4),                  -- counted - expected
  cash_in_total NUMERIC(14,4) DEFAULT 0, cash_out_total NUMERIC(14,4) DEFAULT 0,
  sequence_number INTEGER DEFAULT 0,       -- monotonic order counter for offline numbering
  is_rescue BOOLEAN DEFAULT FALSE,
  notes, created_at
  INDEX(org_id, register_id, state)

pos_cash_movements        -- mid-session cash in/out
  id, org_id, session_id REFERENCES pos_sessions(id) ON DELETE CASCADE,
  direction ('in'|'out'), amount NUMERIC(14,4), reason TEXT,
  created_by, created_at

pos_orders
  id, org_id, session_id REFERENCES pos_sessions(id),
  register_id, cashier_id,
  order_number TEXT,                       -- human ref
  client_order_uuid UUID NOT NULL,         -- offline idempotency key
  customer_id REFERENCES users(id),        -- optional
  state ('draft'|'paid'|'refunded'|'cancelled') DEFAULT 'draft',
  currency CHAR(3) DEFAULT 'USD',
  subtotal NUMERIC(16,4), discount_total NUMERIC(16,4),
  tax_total NUMERIC(16,4), total NUMERIC(16,4),
  amount_paid NUMERIC(16,4), amount_return NUMERIC(16,4),
  is_return BOOLEAN DEFAULT FALSE, origin_order_id REFERENCES pos_orders(id),
  placed_at TIMESTAMPTZ, synced_at TIMESTAMPTZ,
  created_at
  UNIQUE(org_id, session_id, client_order_uuid)   -- IDEMPOTENCY (SC-002)
  INDEX(org_id, session_id), INDEX(org_id, state)

pos_order_lines
  id, org_id, order_id REFERENCES pos_orders(id) ON DELETE CASCADE,
  variant_id, lot_id,
  qty NUMERIC(14,3), unit_price NUMERIC(14,4),
  discount_type ('none'|'percentage'|'fixed') DEFAULT 'none', discount_value NUMERIC(14,4) DEFAULT 0,
  tax_rate_id, tax_amount NUMERIC(14,4),
  line_subtotal NUMERIC(16,4),             -- excl tax, after discount
  line_total NUMERIC(16,4),                -- incl tax
  refunded_qty NUMERIC(14,3) DEFAULT 0,
  note TEXT
  INDEX(org_id, order_id)

pos_payments
  id, org_id, order_id REFERENCES pos_orders(id) ON DELETE CASCADE,
  method_id REFERENCES pos_payment_methods(id),
  amount NUMERIC(14,4), is_change BOOLEAN DEFAULT FALSE,
  card_type TEXT, transaction_id TEXT, gateway_status TEXT, gateway_payload JSONB,
  paid_at TIMESTAMPTZ DEFAULT NOW()
  INDEX(org_id, order_id)

pos_receipts
  id, org_id, order_id REFERENCES pos_orders(id) ON DELETE CASCADE,
  receipt_code TEXT, rendered_html TEXT, snapshot JSONB,   -- immutable order snapshot
  printed_at TIMESTAMPTZ, created_at
  UNIQUE(org_id, receipt_code)
```

Returns reuse `pos_orders` with `is_return=TRUE` and `origin_order_id` set; return lines are `pos_order_lines` with negative-quantity semantics tracked via `origin` line references, and refunds are `pos_payments` rows on the return order. (A dedicated `pos_returns` table is unnecessary — matches Odoo's negative-order pattern and keeps one code path.)

---

## Entity Relationship Summary

```
products 1─* product_variants 1─* variant_barcodes
product_variants *─* stock_locations  (via stock_levels / stock_ledger)
product_variants 1─* stock_lots
warehouses 1─* stock_locations (tree via parent_id)
stock_ledger  ── (append-only) ──> reconciles stock_levels
stock_reservations ── held ──> converts to stock_ledger 'sale' on fulfillment
purchase_orders 1─* purchase_order_lines ; goods_receipts 1─* goods_receipt_lines
pos_registers 1─* pos_sessions 1─* pos_orders 1─* pos_order_lines
pos_orders 1─* pos_payments ; pos_orders 1─1 pos_receipts
pos_orders (is_return) *─1 pos_orders (origin_order_id)
```

## Migration grouping (append to `MIGRATIONS` in `migrationRunner.ts`)

1. `2026_07_v20_inventory_catalog` — uoms, product_categories, products, product_variants, variant_barcodes
2. `2026_07_v21_inventory_locations` — warehouses, stock_locations, stock_lots
3. `2026_07_v22_inventory_ledger` — stock_ledger, stock_levels, stock_reservations
4. `2026_07_v23_inventory_documents` — suppliers, purchase_orders(+lines), goods_receipts(+lines), stock_transfers(+lines), stock_adjustments(+lines), reorder_rules
5. `2026_07_v24_pos_config` — tax_rates, price_lists(+items), discounts, pos_payment_methods, pos_registers
6. `2026_07_v25_pos_transactions` — pos_sessions, pos_cash_movements, pos_orders, pos_order_lines, pos_payments, pos_receipts

Each migration uses `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` (idempotent), never reordered/renamed once shipped.
