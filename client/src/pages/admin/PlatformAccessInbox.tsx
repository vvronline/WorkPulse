import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Shield,
  Loader2,
  X,
  CheckCircle2,
  XCircle,
  Copy,
  AlertTriangle,
  Clock,
  Eye,
  Pencil,
  History,
  BadgeAlert,
} from "lucide-react";
import {
  listIncomingAccessRequests,
  approveAccessRequest,
  denyAccessRequest,
  revokeAccessSession,
} from "../../api";
import ConfirmDialog from "../../components/common/ConfirmDialog";

const EMPTY_ITEMS: any[] = [];

/**
 * Tenant-side Platform Access inbox.
 *
 * Mounted inside the regular Admin panel and visible only to super_admins.
 * Lets the tenant approve/deny incoming platform-admin support-access
 * requests and revoke an active inspector session.
 *
 * The flow this UI participates in:
 *   1. Platform admin opens a request (POST /admin/tenants/:id/access-requests).
 *   2. WE see it here, approve → server returns a one-time 6-digit code,
 *      which we show in a copy-to-clipboard banner exactly once.
 *   3. We share that code with the inspector via a trusted channel.
 *   4. Inspector enters the code on their side → session starts.
 *   5. Active sessions show in the "Active session" card with a Revoke button.
 */
export default function PlatformAccessInbox() {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");

  const [revealedCode, setRevealedCode] = useState<any>(null); // { id, code, expires_at }
  const [denyTarget, setDenyTarget] = useState<any>(null); // { id }
  const [denyReason, setDenyReason] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<any>(null); // request row

  // Cheap polling (refetchInterval) so new requests appear without manual
  // refresh; the page is typically idle so a 15s interval is plenty.
  const {
    data,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: ["admin", "platform-access-inbox"],
    queryFn: async () => {
      const r = await listIncomingAccessRequests({ limit: 50 } as any);
      return {
        requests: ((r.data as any)?.requests || []) as any[],
        active_session: (r.data as any)?.active_session || null,
      };
    },
    refetchInterval: 15_000,
  });

  const items = data?.requests ?? EMPTY_ITEMS;
  const active = data?.active_session ?? null;
  const displayError =
    error ||
    (queryError
      ? (queryError as any)?.response?.data?.error || "Failed to load"
      : "");

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["admin", "platform-access-inbox"],
    });

  const handleApprove = async (req: any) => {
    try {
      const r = await approveAccessRequest(req.id);
      setRevealedCode({
        id: req.id,
        code: (r.data as any)?.approval_code,
        expires_at: (r.data as any)?.code_expires_at,
        inspector: req.requested_by_name,
      });
      invalidate();
    } catch (e: any) {
      setError(e.response?.data?.error || "Failed to approve");
    }
  };

  const handleDeny = async () => {
    if (!denyTarget) return;
    try {
      await denyAccessRequest(denyTarget.id, denyReason);
      setDenyTarget(null);
      setDenyReason("");
      invalidate();
    } catch (e: any) {
      setError(e.response?.data?.error || "Failed to deny");
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await revokeAccessSession(revokeTarget.id, "Revoked from admin panel");
      setRevokeTarget(null);
      invalidate();
    } catch (e: any) {
      setError(e.response?.data?.error || "Failed to revoke");
    }
  };

  const pending = items.filter((r) => r.status === "pending");
  const history = items.filter((r) => r.status !== "pending");

  return (
    <div
      className="platform-access-inbox"
      style={{ display: "flex", flexDirection: "column", gap: 20 }}
    >
      <header>
        <h2
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 0,
          }}
        >
          <Shield size={18} /> Platform Support Access
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: 0 }}>
          Review and approve access requests from platform support staff. Each
          approval mints a one-time 6-digit code that you must share with the
          inspector over a trusted channel.
        </p>
      </header>

      {displayError && (
        <div role="alert" style={alertStyle("danger")}>
          <span>{displayError}</span>
          <button
            onClick={() => setError("")}
            aria-label="Close"
            style={closeBtn}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Active session card */}
      {active && (
        <section style={{ ...cardStyle, borderColor: "var(--warning)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 8,
            }}
          >
            <BadgeAlert size={18} style={{ color: "var(--warning)" }} />
            <strong style={{ flex: 1 }}>
              Inspector currently active in your workspace
            </strong>
            <button
              style={{
                ...btn,
                background: "var(--danger)",
                color: "#fff",
                borderColor: "var(--danger)",
              }}
              onClick={() => setRevokeTarget(active)}
            >
              Revoke session
            </button>
          </div>
          <div style={metaGrid}>
            <div>
              <strong>Inspector:</strong>{" "}
              {active.requested_by_name || `User #${active.requested_by}`}
            </div>
            <div>
              <strong>Reason:</strong> {active.reason}
            </div>
            <div>
              <strong>Scope:</strong> {active.scope}
            </div>
            <div>
              <strong>Started:</strong>{" "}
              {active.consumed_at
                ? new Date(active.consumed_at).toLocaleTimeString()
                : "—"}
            </div>
            <div>
              <strong>Ends:</strong>{" "}
              {active.session_ends_at
                ? new Date(active.session_ends_at).toLocaleTimeString()
                : "—"}
            </div>
          </div>
        </section>
      )}

      {/* One-time revealed code */}
      {revealedCode && (
        <section style={{ ...cardStyle, borderColor: "var(--success)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 8,
            }}
          >
            <CheckCircle2 size={18} style={{ color: "var(--success)" }} />
            <strong style={{ flex: 1 }}>Approval code generated</strong>
            <button
              onClick={() => setRevealedCode(null)}
              style={closeBtn}
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
          <p
            style={{
              color: "var(--text-secondary)",
              fontSize: 12,
              margin: "0 0 10px",
            }}
          >
            Share this code with{" "}
            <strong>{revealedCode.inspector || "the inspector"}</strong> over a
            trusted channel (phone / support ticket). It expires at{" "}
            <strong>
              {revealedCode.expires_at
                ? new Date(revealedCode.expires_at).toLocaleTimeString()
                : "—"}
            </strong>{" "}
            and is shown only this once.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={codeBox}>{revealedCode.code}</div>
            <button
              style={btn}
              onClick={() => navigator.clipboard?.writeText(revealedCode.code)}
              title="Copy to clipboard"
            >
              <Copy size={14} /> Copy
            </button>
          </div>
        </section>
      )}

      {/* Pending requests */}
      <section style={cardStyle}>
        <h3 style={sectionH3}>
          <Clock size={14} /> Pending requests
          {pending.length > 0 && (
            <span style={badgeWarn}>{pending.length}</span>
          )}
        </h3>
        {loading ? (
          <div style={emptyMsg}>
            <Loader2 size={14} className="spin" /> Loading…
          </div>
        ) : pending.length === 0 ? (
          <div style={emptyMsg}>No pending requests.</div>
        ) : (
          <ul style={listStyle}>
            {pending.map((req) => (
              <li key={req.id} style={listItem}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>
                    {req.requested_by_name || `Inspector #${req.requested_by}`}
                    {req.requested_by_email && (
                      <span
                        style={{
                          marginLeft: 6,
                          fontWeight: 400,
                          color: "var(--text-muted)",
                        }}
                      >
                        · {req.requested_by_email}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: "var(--text-secondary)",
                      marginTop: 4,
                    }}
                  >
                    {req.reason}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginTop: 4,
                      display: "flex",
                      gap: 12,
                    }}
                  >
                    <span
                      style={pillStyle(req.scope === "read" ? "info" : "warn")}
                    >
                      {req.scope === "read" ? (
                        <Eye size={11} />
                      ) : (
                        <Pencil size={11} />
                      )}
                      {req.scope}
                    </span>
                    <span>{req.duration_minutes} min</span>
                    <span>· requested {timeAgo(req.requested_at)}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    style={{
                      ...btn,
                      background: "var(--success)",
                      color: "#fff",
                      borderColor: "var(--success)",
                    }}
                    onClick={() => handleApprove(req)}
                  >
                    <CheckCircle2 size={13} /> Approve
                  </button>
                  <button
                    style={{
                      ...btn,
                      color: "var(--danger)",
                      borderColor: "var(--danger)",
                    }}
                    onClick={() => setDenyTarget(req)}
                  >
                    <XCircle size={13} /> Deny
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* History */}
      <section style={cardStyle}>
        <h3 style={sectionH3}>
          <History size={14} /> Recent history
        </h3>
        {history.length === 0 ? (
          <div style={emptyMsg}>No previous requests yet.</div>
        ) : (
          <table
            style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                <th style={th}>When</th>
                <th style={th}>Inspector</th>
                <th style={th}>Reason</th>
                <th style={th}>Status</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {history.slice(0, 20).map((req) => (
                <tr
                  key={req.id}
                  style={{ borderTop: "1px solid var(--border, #2a2d33)" }}
                >
                  <td style={td}>
                    {new Date(req.requested_at).toLocaleString()}
                  </td>
                  <td style={td}>
                    {req.requested_by_name || `#${req.requested_by}`}
                  </td>
                  <td style={{ ...td, color: "var(--text-secondary)" }}>
                    {req.reason}
                  </td>
                  <td style={td}>
                    <StatusBadge status={req.status} />
                  </td>
                  <td style={td}>
                    {req.status === "consumed" && !req.revoked_at && (
                      <button
                        style={miniBtn}
                        onClick={() => setRevokeTarget(req)}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Deny dialog */}
      {denyTarget && (
        <ConfirmDialog
          isOpen={true}
          title="Deny access request"
          message={
            <div>
              <p>Optionally tell the inspector why you're denying.</p>
              <textarea
                value={denyReason}
                onChange={(e) => setDenyReason(e.target.value)}
                placeholder="Reason (optional)"
                maxLength={500}
                rows={3}
                style={{ width: "100%", padding: 8, fontFamily: "inherit" }}
              />
            </div>
          }
          confirmText="Deny"
          cancelText="Keep open"
          isDanger
          onConfirm={handleDeny}
          onCancel={() => {
            setDenyTarget(null);
            setDenyReason("");
          }}
        />
      )}

      {revokeTarget && (
        <ConfirmDialog
          isOpen={true}
          title="Revoke inspector session"
          message={`Force ${revokeTarget.requested_by_name || "the inspector"} out of your workspace immediately?`}
          confirmText="Revoke session"
          cancelText="Keep session"
          isDanger
          onConfirm={handleRevoke}
          onCancel={() => setRevokeTarget(null)}
        />
      )}
    </div>
  );
}

/* ── Small inline UI helpers (no extra stylesheet) ──────────────────────── */
const cardStyle: React.CSSProperties = {
  border: "1px solid var(--border, #2a2d33)",
  borderRadius: 10,
  padding: "14px 16px",
  background: "var(--bg-panel, #1b1d22)",
};
const sectionH3: React.CSSProperties = {
  marginTop: 0,
  marginBottom: 10,
  fontSize: 13,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-muted)",
  display: "flex",
  alignItems: "center",
  gap: 6,
};
const metaGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 6,
  fontSize: 12,
  color: "var(--text-secondary)",
};
const btn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border, #2a2d33)",
  background: "var(--bg-input, #14161a)",
  color: "var(--text-primary)",
  fontSize: 12,
  cursor: "pointer",
};
const miniBtn: React.CSSProperties = {
  ...btn,
  padding: "3px 8px",
  fontSize: 11,
};
const closeBtn: React.CSSProperties = {
  background: "none",
  border: 0,
  cursor: "pointer",
  color: "inherit",
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const listItem: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 14,
  padding: 12,
  borderRadius: 8,
  background: "var(--bg-input, #14161a)",
  border: "1px solid var(--border, #2a2d33)",
};
const emptyMsg: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  padding: "8px 0",
};
const codeBox: React.CSSProperties = {
  flex: 1,
  fontFamily: "SF Mono, Cascadia Mono, monospace",
  fontSize: 28,
  letterSpacing: 8,
  padding: "12px 18px",
  textAlign: "center",
  borderRadius: 8,
  background: "var(--bg-input, #14161a)",
  border: "1px dashed var(--success)",
  color: "var(--success)",
};
const th: React.CSSProperties = {
  padding: "8px 6px",
  fontWeight: 500,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
const td: React.CSSProperties = { padding: "8px 6px" };
const badgeWarn: React.CSSProperties = {
  background: "var(--warning)",
  color: "#000",
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 999,
  marginLeft: "auto",
};

function alertStyle(kind: string): React.CSSProperties {
  const colors: Record<string, { bg: string; fg: string }> = {
    danger: {
      bg: "color-mix(in srgb, var(--danger) 12%, transparent)",
      fg: "var(--danger)",
    },
    success: {
      bg: "color-mix(in srgb, var(--success) 12%, transparent)",
      fg: "var(--success)",
    },
  };
  const c = colors[kind] || colors.danger;
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 8,
    background: c.bg,
    color: c.fg,
    border: `1px solid ${c.fg}`,
    fontSize: 13,
  };
}

function pillStyle(kind: string): React.CSSProperties {
  const palette: Record<string, { bg: string; fg: string }> = {
    info: {
      bg: "color-mix(in srgb, var(--accent) 14%, transparent)",
      fg: "var(--accent)",
    },
    warn: {
      bg: "color-mix(in srgb, var(--warning) 14%, transparent)",
      fg: "var(--warning)",
    },
  };
  const c = palette[kind] || palette.info;
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    padding: "1px 8px",
    borderRadius: 999,
    background: c.bg,
    color: c.fg,
    fontSize: 11,
  };
}

function StatusBadge({ status }: { status: string }) {
  const palette: Record<string, string> = {
    approved: "var(--accent)",
    consumed: "var(--accent)",
    denied: "var(--danger)",
    revoked: "var(--danger)",
    expired: "var(--text-muted)",
    cancelled: "var(--text-muted)",
    pending: "var(--warning)",
  };
  return (
    <span
      style={{
        padding: "1px 8px",
        borderRadius: 999,
        fontSize: 11,
        background: "color-mix(in srgb, currentColor 14%, transparent)",
        color: palette[status] || "var(--text-muted)",
      }}
    >
      {status}
    </span>
  );
}

function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
