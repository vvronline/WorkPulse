// Reusable pagination control.
//
// Drives any list that uses the standard server pagination shape
// (`{ limit, offset, total, hasMore }`) — currently Projects list,
// per-project Tasks panel, and the Backlog list.

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

interface PaginationProps {
    total: number;
    limit: number;
    offset: number;
    onPageChange?: (nextOffset: number) => void;
    onLimitChange?: (nextLimit: number) => void;
    pageSizeOptions?: number[];
    compact?: boolean;
    itemLabel?: string;
}

export default function Pagination({
    total,
    limit,
    offset,
    onPageChange,
    onLimitChange,
    pageSizeOptions = [10, 25, 50, 100],
    compact = false,
    itemLabel = "item",
}: PaginationProps) {
    if (!total || total <= 0) return null;

    const safeLimit = Math.max(1, Number(limit) || 1);
    const safeOffset = Math.max(0, Number(offset) || 0);
    const page = Math.floor(safeOffset / safeLimit) + 1;
    const pageCount = Math.max(1, Math.ceil(total / safeLimit));
    const startRow = total === 0 ? 0 : safeOffset + 1;
    const endRow = Math.min(total, safeOffset + safeLimit);

    const onlyOnePage = pageCount <= 1 && !onLimitChange;
    if (onlyOnePage) {
        // Still useful to know the count, but no nav needed.
        return (
            <div style={styles.bar(compact)}>
                <span style={styles.summary}>
                    {total} {itemLabel}
                    {total === 1 ? "" : "s"}
                </span>
            </div>
        );
    }

    const goto = (nextPage: number) => {
        const clamped = Math.max(1, Math.min(pageCount, nextPage));
        onPageChange?.((clamped - 1) * safeLimit);
    };

    return (
        <div style={styles.bar(compact)}>
            <span style={styles.summary}>
                {startRow}–{endRow} of {total} {itemLabel}
                {total === 1 ? "" : "s"}
            </span>

            <div style={styles.controls}>
                {onLimitChange && (
                    <label style={styles.sizeLabel}>
                        <span style={styles.sizeText}>Rows</span>
                        <select
                            value={safeLimit}
                            onChange={(e) => onLimitChange(parseInt(e.target.value, 10))}
                            style={styles.select}
                        >
                            {pageSizeOptions.map((n) => (
                                <option key={n} value={n}>
                                    {n}
                                </option>
                            ))}
                        </select>
                    </label>
                )}

                <div style={styles.pager}>
                    <button
                        type="button"
                        style={{ ...styles.iconBtn, ...(page <= 1 ? styles.disabled : null) }}
                        onClick={() => goto(1)}
                        disabled={page <= 1}
                        title="First page"
                    >
                        <ChevronsLeft size={14} />
                    </button>
                    <button
                        type="button"
                        style={{ ...styles.iconBtn, ...(page <= 1 ? styles.disabled : null) }}
                        onClick={() => goto(page - 1)}
                        disabled={page <= 1}
                        title="Previous page"
                    >
                        <ChevronLeft size={14} />
                    </button>
                    <span style={styles.pageInfo}>
                        Page <strong>{page}</strong> of {pageCount}
                    </span>
                    <button
                        type="button"
                        style={{ ...styles.iconBtn, ...(page >= pageCount ? styles.disabled : null) }}
                        onClick={() => goto(page + 1)}
                        disabled={page >= pageCount}
                        title="Next page"
                    >
                        <ChevronRight size={14} />
                    </button>
                    <button
                        type="button"
                        style={{ ...styles.iconBtn, ...(page >= pageCount ? styles.disabled : null) }}
                        onClick={() => goto(pageCount)}
                        disabled={page >= pageCount}
                        title="Last page"
                    >
                        <ChevronsRight size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
}

const styles = {
    bar: (compact: boolean): React.CSSProperties => ({
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        padding: compact ? "8px 12px" : "12px 4px",
        flexWrap: "wrap",
    }),
    summary: { fontSize: 12, color: "var(--text-secondary, #9ca3af)" } as React.CSSProperties,
    controls: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } as React.CSSProperties,
    sizeLabel: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--text-secondary, #9ca3af)",
    } as React.CSSProperties,
    sizeText: { fontSize: 12 } as React.CSSProperties,
    select: {
        padding: "4px 8px",
        borderRadius: 6,
        border: "1px solid var(--border, #2a2f3a)",
        background: "var(--input-bg, transparent)",
        color: "inherit",
        fontSize: 12,
        cursor: "pointer",
    } as React.CSSProperties,
    pager: { display: "inline-flex", alignItems: "center", gap: 4 } as React.CSSProperties,
    iconBtn: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        padding: 0,
        borderRadius: 6,
        border: "1px solid var(--border, #2a2f3a)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
    } as React.CSSProperties,
    disabled: { opacity: 0.4, cursor: "not-allowed" } as React.CSSProperties,
    pageInfo: { fontSize: 12, color: "var(--text-secondary, #9ca3af)", padding: "0 8px" } as React.CSSProperties,
};