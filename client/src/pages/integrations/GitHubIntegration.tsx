// GitHub integration detail panel.
//
// Connection flow
// ───────────────
//   1. User clicks "Connect GitHub" → we POST /api/integrations/github/oauth/start
//      and open the returned `authorize_url` in a popup.
//   2. The popup completes the OAuth round-trip and posts a
//      `{type:'github-connected', login:'…'}` message back to us, then closes.
//   3. We re-fetch GET /api/integrations/github/status to refresh the UI.
//   4. The user picks repos from the list returned by GET /repos and submits
//      them to POST /repos/connect, which installs the webhook automatically
//      via the GitHub REST API. No secret pasting required.

import { useEffect, useState, useRef } from "react";
import { useAuth } from "../../AuthContext";
import {
  getGithubStatus,
  startGithubOAuth,
  listGithubRepos,
  connectGithubRepos,
  disconnectGithubRepo,
  disconnectGithub,
} from "../../api";
import { useToast } from "../../components/common/Toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
// lucide-react doesn't ship a "Github" mark; GitBranch is the closest
// rendering of the brand at small sizes.
import {
  GitBranch as Github,
  Link as LinkIcon,
  Unlink,
  Plus,
  X,
  ExternalLink,
  Loader2,
} from "lucide-react";

const EMPTY_REPOS: any[] = [];

const ROLE_LEVELS: Record<string, number> = {
  employee: 1,
  team_lead: 2,
  manager: 3,
  hr_admin: 4,
  super_admin: 5,
  platform_admin: 6,
};

interface GitHubIntegrationProps {
  onStatusChange?: (status: any) => void;
}

/**
 * Detail panel for the GitHub provider, embedded inside the Integrations
 * catalog. Exposes a `onStatusChange(connected)` callback so the parent
 * catalog can refresh the card's status badge / subtitle.
 */
export default function GitHubIntegration({
  onStatusChange,
}: GitHubIntegrationProps) {
  const { user } = useAuth() as any;
  const toast = useToast() as any;
  const queryClient = useQueryClient();
  const canManage = (ROLE_LEVELS[user?.role] || 1) >= 3; // manager+

  const [connecting, setConnecting] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const popupRef = useRef<Window | null>(null);

  const {
    data: status = null,
    isLoading: loading,
    error,
  } = useQuery({
    queryKey: ["integrations", "github", "status"],
    queryFn: async () => {
      const { data } = await getGithubStatus(); // { connected, github_login, github_avatar, repos:[] }
      return data;
    },
  });

  useEffect(() => {
    if (error)
      toast.error(
        (error as any).response?.data?.error ||
          "Failed to load integration status",
      );
  }, [error]);

  useEffect(() => {
    if (status) onStatusChange?.(status);
  }, [status]);

  // Listen for the postMessage from the OAuth popup so we can refresh
  // automatically. We accept the message from any origin because the
  // popup is the same-origin /api/integrations/github/oauth/callback —
  // the script there sets window.opener.postMessage(..., '*') so the
  // origin matches whatever WorkPulse is served from.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === "github-connected") {
        toast.success(`Connected to GitHub as ${e.data.login}`);
        setConnecting(false);
        void queryClient.invalidateQueries({
          queryKey: ["integrations", "github", "status"],
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function onConnect() {
    try {
      setConnecting(true);
      const { data } = await startGithubOAuth();
      // Open in a centered popup (600×750 is enough for GitHub's OAuth dialog).
      const w = 600,
        h = 750;
      const left = window.screenX + (window.outerWidth - w) / 2;
      const top = window.screenY + (window.outerHeight - h) / 2;
      popupRef.current = window.open(
        (data as any).authorize_url,
        "github-oauth",
        `width=${w},height=${h},left=${left},top=${top}`,
      );
      if (!popupRef.current) {
        toast.error(
          "Popup blocked. Please allow popups for this site and try again.",
        );
        setConnecting(false);
      }
    } catch (e: any) {
      setConnecting(false);
      if (e.response?.status === 503) {
        toast.error(
          "GitHub OAuth is not configured on this server. Ask your platform admin to set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.",
        );
      } else {
        toast.error(e.response?.data?.error || "Failed to start GitHub OAuth");
      }
    }
  }

  async function onDisconnectAll() {
    if (
      !confirm(
        "Disconnect GitHub? This will remove every WorkPulse webhook from your repositories.",
      )
    )
      return;
    try {
      await disconnectGithub();
      toast.success("GitHub disconnected");
      await queryClient.invalidateQueries({
        queryKey: ["integrations", "github", "status"],
      });
    } catch (e: any) {
      toast.error(e.response?.data?.error || "Failed to disconnect");
    }
  }

  async function onDisconnectRepo(fullName: string) {
    if (
      !confirm(`Disconnect ${fullName}? The webhook on GitHub will be removed.`)
    )
      return;
    try {
      await disconnectGithubRepo(fullName);
      toast.success(`Removed ${fullName}`);
      await queryClient.invalidateQueries({
        queryKey: ["integrations", "github", "status"],
      });
    } catch (e: any) {
      toast.error(e.response?.data?.error || "Failed");
    }
  }

  if (loading) return <div style={styles.empty}>Loading…</div>;

  return (
    <div>
      <section style={styles.providerCard}>
        <div style={styles.providerHead}>
          <div style={styles.providerLogo}>
            <Github size={22} />
          </div>
          <div style={{ flex: 1 }}>
            <h2 style={styles.providerTitle}>GitHub</h2>
            <p style={styles.providerDesc}>
              One click to authorize; we install a webhook on each repo you
              choose. No manual secret pasting.
            </p>
          </div>
          {!canManage ? (
            <span style={styles.mutedTag}>Manager+ required to configure</span>
          ) : status?.connected ? (
            <button style={styles.dangerBtn} onClick={onDisconnectAll}>
              <Unlink size={14} /> Disconnect
            </button>
          ) : (
            <button
              style={styles.primaryBtn}
              onClick={onConnect}
              disabled={connecting}
            >
              {connecting ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <LinkIcon size={14} />
              )}
              {connecting ? " Waiting for GitHub…" : " Connect GitHub"}
            </button>
          )}
        </div>

        {status?.connected && (
          <div style={styles.providerBody}>
            <div style={styles.connectedAs}>
              {status.github_avatar && (
                <img src={status.github_avatar} alt="" style={styles.avatar} />
              )}
              <div>
                <div style={{ fontSize: 13 }}>
                  Connected as <strong>{status.github_login}</strong>
                </div>
                <a
                  href={`https://github.com/${status.github_login}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={styles.link}
                >
                  View on GitHub <ExternalLink size={11} />
                </a>
              </div>
            </div>

            <div style={styles.repoList}>
              <header style={styles.sectionHeader}>
                <strong>Connected repositories</strong>
                {canManage && (
                  <button
                    style={styles.secondaryBtn}
                    onClick={() => setShowPicker(true)}
                  >
                    <Plus size={14} /> Add repository
                  </button>
                )}
              </header>
              {(status.repos || []).length === 0 ? (
                <div style={styles.emptyRepos}>
                  No repositories connected yet. Click{" "}
                  <strong>Add repository</strong> to install a webhook on one or
                  more of your repos.
                </div>
              ) : (
                <ul style={styles.repos}>
                  {status.repos.map((r: any) => (
                    <li key={r.full_name} style={styles.repoRow}>
                      <a
                        href={r.html_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={styles.repoLink}
                      >
                        <Github size={14} /> {r.full_name}
                      </a>
                      {canManage && (
                        <button
                          title="Disconnect this repo"
                          style={{ ...styles.iconBtn, color: "#ef4444" }}
                          onClick={() => onDisconnectRepo(r.full_name)}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      {showPicker && (
        <RepoPicker
          onClose={() => setShowPicker(false)}
          onConnected={async () => {
            setShowPicker(false);
            await queryClient.invalidateQueries({
              queryKey: ["integrations", "github", "status"],
            });
          }}
        />
      )}

      <Help />
    </div>
  );
}

interface RepoPickerProps {
  onClose: () => void;
  onConnected: () => Promise<void> | void;
}

function RepoPicker({ onClose, onConnected }: RepoPickerProps) {
  const toast = useToast() as any;
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const {
    data: repos = EMPTY_REPOS,
    isLoading: loading,
    error,
  } = useQuery({
    queryKey: ["integrations", "github", "repos"],
    queryFn: async (): Promise<any[]> =>
      ((await listGithubRepos()).data as any)?.repos || [],
  });

  useEffect(() => {
    if (error)
      toast.error(
        (error as any).response?.data?.error || "Failed to list repos",
      );
  }, [error]);

  const visible = repos.filter((r: any) =>
    r.full_name.toLowerCase().includes(filter.toLowerCase()),
  );

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function onSubmit() {
    if (selected.size === 0) return;
    try {
      setSubmitting(true);
      const { data } = await connectGithubRepos([...selected]);
      const ok = (data as any).results.filter((r: any) => r.ok).length;
      const fail = (data as any).results.filter((r: any) => !r.ok).length;
      if (ok > 0) toast.success(`Connected ${ok} repo${ok !== 1 ? "s" : ""}`);
      if (fail > 0) toast.error(`${fail} failed — check repo permissions`);
      await onConnected();
    } catch (e: any) {
      toast.error(e.response?.data?.error || "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div
        style={{ ...styles.modal, maxWidth: 560 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header style={styles.modalHeader}>
          <h2 style={{ margin: 0 }}>Add repositories</h2>
          <button style={styles.iconBtn} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div style={{ padding: 16 }}>
          <input
            style={styles.input}
            placeholder="Filter repositories…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          <div style={styles.repoPickList}>
            {loading ? (
              <div style={{ padding: 16 }}>Loading from GitHub…</div>
            ) : visible.length === 0 ? (
              <div style={{ padding: 16, color: "#9ca3af" }}>
                No repositories match.
              </div>
            ) : (
              visible.map((r) => (
                <label key={r.full_name} style={styles.repoPickItem}>
                  <input
                    type="checkbox"
                    checked={selected.has(r.full_name)}
                    onChange={() => toggle(r.full_name)}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13 }}>
                      <strong>{r.full_name}</strong>
                      {r.private && (
                        <span style={styles.privateTag}>private</span>
                      )}
                    </div>
                    {r.description && (
                      <div
                        style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}
                      >
                        {r.description}
                      </div>
                    )}
                  </div>
                </label>
              ))
            )}
          </div>
          <footer style={styles.modalFooter}>
            <span
              style={{ fontSize: 12, color: "#9ca3af", marginRight: "auto" }}
            >
              {selected.size} selected
            </span>
            <button type="button" style={styles.secondaryBtn} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              style={styles.primaryBtn}
              onClick={onSubmit}
              disabled={submitting || selected.size === 0}
            >
              {submitting
                ? "Installing webhooks…"
                : `Add ${selected.size || ""} repo${selected.size === 1 ? "" : "s"}`}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

function Help() {
  return (
    <section style={styles.help}>
      <h3 style={{ marginTop: 0 }}>How it works</h3>
      <ol style={{ paddingLeft: 20, lineHeight: 1.6 }}>
        <li>
          Create a project with a key (e.g. <code style={styles.code}>WEB</code>
          ) on the <strong>Projects</strong> page.
        </li>
        <li>
          Create a task in that project — it'll get an issue key like{" "}
          <code style={styles.code}>WEB-123</code>.
        </li>
        <li>
          On a connected repo, create a branch whose name contains the key:
          <code style={styles.codeBlock}>
            git checkout -b feature/WEB-123-add-login
          </code>
        </li>
        <li>
          Push it. The branch appears on the task's <strong>Development</strong>{" "}
          section instantly.
        </li>
        <li>
          Open a pull request whose title or body mentions{" "}
          <code style={styles.code}>WEB-123</code>. The PR's status (open →
          merged) is tracked automatically.
        </li>
        <li>Commits that mention the key in their message are also linked.</li>
      </ol>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  providerCard: {
    border: "1px solid var(--border, #2a2f3a)",
    borderRadius: 12,
    background: "var(--card-bg, #1a1d24)",
    overflow: "hidden",
  },
  providerHead: {
    display: "flex",
    gap: 14,
    padding: 18,
    alignItems: "center",
    borderBottom: "1px solid var(--border, #2a2f3a)",
  },
  providerLogo: {
    width: 40,
    height: 40,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    background: "rgba(255,255,255,0.06)",
  },
  providerTitle: { margin: 0, fontSize: 16, fontWeight: 700 },
  providerDesc: {
    margin: "2px 0 0",
    color: "var(--text-secondary, #9ca3af)",
    fontSize: 12,
  },
  providerBody: { padding: 18 },
  connectedAs: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    marginBottom: 16,
  },
  avatar: { width: 36, height: 36, borderRadius: "50%" },
  link: {
    fontSize: 11,
    color: "var(--accent, #2383e2)",
    display: "inline-flex",
    gap: 4,
    alignItems: "center",
    textDecoration: "none",
  },
  repoList: { borderTop: "1px solid var(--border, #2a2f3a)", paddingTop: 14 },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  emptyRepos: {
    padding: 14,
    fontSize: 12,
    color: "#9ca3af",
    background: "rgba(255,255,255,0.03)",
    borderRadius: 8,
  },
  repos: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  repoRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 6,
    background: "rgba(255,255,255,0.04)",
  },
  repoLink: {
    flex: 1,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    color: "inherit",
    textDecoration: "none",
  },
  repoPickList: {
    maxHeight: 360,
    overflow: "auto",
    marginTop: 10,
    border: "1px solid var(--border, #2a2f3a)",
    borderRadius: 8,
  },
  repoPickItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 12px",
    borderBottom: "1px solid var(--border-subtle, #1f232b)",
    cursor: "pointer",
  },
  privateTag: {
    marginLeft: 6,
    padding: "1px 6px",
    borderRadius: 4,
    background: "rgba(245,158,11,0.15)",
    color: "#f59e0b",
    fontSize: 10,
    fontWeight: 600,
  },
  help: {
    marginTop: 30,
    padding: 18,
    background: "rgba(99,102,241,0.06)",
    border: "1px solid rgba(99,102,241,0.2)",
    borderRadius: 12,
    fontSize: 13,
    color: "var(--text-secondary, #cdd5e0)",
  },
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 14px",
    borderRadius: 8,
    border: "none",
    background: "var(--accent, #2383e2)",
    color: "white",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
  },
  secondaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid var(--border, #2a2f3a)",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontWeight: 500,
    fontSize: 13,
  },
  dangerBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid rgba(239,68,68,0.4)",
    background: "rgba(239,68,68,0.1)",
    color: "#ef4444",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
  },
  iconBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderRadius: 6,
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
  },
  mutedTag: {
    padding: "4px 10px",
    borderRadius: 6,
    background: "rgba(255,255,255,0.04)",
    color: "#9ca3af",
    fontSize: 11,
  },
  empty: { padding: 48, textAlign: "center", color: "#9ca3af" },
  input: {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--border, #2a2f3a)",
    background: "var(--input-bg, #0f1115)",
    color: "inherit",
    fontSize: 13,
    boxSizing: "border-box",
  },
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(15,17,21,0.75)",
    backdropFilter: "blur(2px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
    padding: 16,
  },
  modal: {
    width: "100%",
    maxWidth: 480,
    background: "#1a1d24",
    color: "#e5e7eb",
    borderRadius: 12,
    border: "1px solid #2a2f3a",
    boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px",
    borderBottom: "1px solid var(--border, #2a2f3a)",
  },
  modalFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 14,
    alignItems: "center",
  },
  code: {
    padding: "1px 5px",
    borderRadius: 4,
    background: "rgba(255,255,255,0.08)",
    fontFamily: "monospace",
    fontSize: 12,
  },
  codeBlock: {
    display: "block",
    padding: "6px 10px",
    borderRadius: 6,
    background: "rgba(0,0,0,0.4)",
    fontFamily: "monospace",
    fontSize: 12,
    margin: "4px 0",
  },
};
