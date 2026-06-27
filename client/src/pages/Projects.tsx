// Projects admin page (Stage 3).
//
// What this page does
// ───────────────────
//   • Lists every project in the org (active by default, with a toggle to
//     include archived ones).
//   • Lets manager+ users create a new project. The "key" is the Jira-style
//     prefix — entirely user-defined; we validate 2–10 uppercase
//     letters/digits/underscores starting with a letter, mirroring the DB
//     CHECK constraint so the request fails client-side before hitting the
//     API.
//   • Lets the user edit name / description / colour / lead. The KEY is
//     intentionally immutable post-creation (changing it would orphan every
//     existing PROJ-N reference in branches, commits, history).
//   • Archive / unarchive in one click. Delete is allowed only when the
//     project has zero tasks (server enforces this too).
//
// There's no client-side router for /projects/:id yet — once you click a
// project we just list its tasks inline. A dedicated detail page can come
// later when we wire the Tasks page to filter by project.

import { useEffect, useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useAuth } from "../AuthContext";
import {
  getProjects,
  createProject,
  updateProject,
  archiveProject,
  deleteProject,
  getProjectTasks,
  getAssignableUsers,
} from "../api";
import { useToast } from "../components/common/Toast";
import Pagination from "../components/common/Pagination";
import {
  Plus,
  Archive,
  ArchiveRestore,
  Trash2,
  Edit3,
  Folder,
  ExternalLink,
  X,
} from "lucide-react";

const ROLE_LEVELS: Record<string, number> = {
  employee: 1,
  team_lead: 2,
  manager: 3,
  hr_admin: 4,
  super_admin: 5,
  platform_admin: 6,
};
const KEY_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
const COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#3b82f6",
  "#ec4899",
  "#14b8a6",
];
const EMPTY_PROJECTS: any[] = [];
const EMPTY_USERS: any[] = [];
const EMPTY_TASKS: any[] = [];

export default function Projects() {
  const { user } = useAuth() as any;
  const toast = useToast() as any;
  const queryClient = useQueryClient();
  const canEdit = (ROLE_LEVELS[user?.role] || 1) >= 3; // manager+
  // Delete is destructive — gated to super_admin and platform_admin
  // (both clear the server's requireRole('super_admin') check). Previously
  // only an exact "super_admin" string matched, which hid the trash icon
  // for platform admins.
  const canDelete = (ROLE_LEVELS[user?.role] || 1) >= 5;

  const [includeArchived, setIncludeArchived] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any>(null); // project being edited
  const [selectedId, setSelectedId] = useState<any>(null);
  // Pagination state for the projects grid. We use server-side pagination
  // so an org with hundreds of projects doesn't render them all at once.
  const [pageLimit, setPageLimit] = useState(12);
  const [pageOffset, setPageOffset] = useState(0);

  // Reset to page 1 whenever the filter (archived toggle) or page size
  // changes — otherwise we could end up on an offset past the new total.
  useEffect(() => {
    setPageOffset(0);
  }, [includeArchived, pageLimit]);

  const { data: projectsData, isLoading: loading } = useQuery({
    queryKey: ["admin", "projects", includeArchived, pageLimit, pageOffset],
    queryFn: async () => {
      const { data } = await getProjects(includeArchived, {
        limit: pageLimit,
        offset: pageOffset,
      } as any);
      // Server returns `{ projects, pagination }` when `paginate=1` is
      // sent. We always send it here, but stay defensive in case the
      // server hasn't been redeployed yet.
      const d = data as any;
      if (d && Array.isArray(d.projects)) {
        return {
          projects: d.projects as any[],
          total: d.pagination?.total ?? d.projects.length,
        };
      }
      if (Array.isArray(d)) {
        return { projects: d as any[], total: d.length };
      }
      return { projects: [] as any[], total: 0 };
    },
  });
  const projects = projectsData?.projects ?? EMPTY_PROJECTS;
  const pageTotal = projectsData?.total ?? 0;

  // Assignable-users is fine to fetch in parallel — most orgs have <500.
  const { data: users = EMPTY_USERS } = useQuery({
    queryKey: ["admin", "assignable-users"],
    queryFn: async () => ((await getAssignableUsers()).data as any[]) || [],
  });

  function openCreate() {
    setEditing(null);
    setShowForm(true);
  }
  function openEdit(p: any) {
    setEditing(p);
    setShowForm(true);
  }

  async function onArchive(p: any) {
    try {
      await archiveProject(p.id, !p.is_archived);
      toast.success(p.is_archived ? "Project unarchived" : "Project archived");
      await queryClient.invalidateQueries({ queryKey: ["admin", "projects"] });
    } catch (e: any) {
      toast.error(e.response?.data?.error || "Failed");
    }
  }

  async function onDelete(p: any) {
    if (
      !confirm(`Delete project "${p.name}" permanently? This cannot be undone.`)
    )
      return;
    try {
      await deleteProject(p.id);
      toast.success("Project deleted");
      if (selectedId === p.id) setSelectedId(null);
      await queryClient.invalidateQueries({ queryKey: ["admin", "projects"] });
    } catch (e: any) {
      // Server refuses (409 PROJECT_NOT_EMPTY) when tasks still belong
      // to the project. Offer the super_admin a clear, second-step
      // confirmation to force-detach the tasks and proceed. The tasks
      // themselves are kept; only their issue key (project_id +
      // task_number) is cleared.
      const data = e.response?.data;
      if (e.response?.status === 409 && data?.code === "PROJECT_NOT_EMPTY") {
        const n = data.task_count || "?";
        const ok = confirm(
          `"${p.name}" still contains ${n} task${n === 1 ? "" : "s"}.\n\n` +
            `Force-delete will detach every task from this project — the tickets stay, ` +
            `but they lose their ${p.key}-N issue key, and any GitHub branches/PRs that ` +
            `mention those keys will no longer link back.\n\n` +
            `Continue with force-delete?`,
        );
        if (!ok) return;
        try {
          const res = await deleteProject(p.id, { force: true } as any);
          const detached = (res as any)?.data?.detached_tasks || n;
          toast.success(
            `Project deleted (detached ${detached} task${detached === 1 ? "" : "s"})`,
          );
          if (selectedId === p.id) setSelectedId(null);
          await queryClient.invalidateQueries({
            queryKey: ["admin", "projects"],
          });
        } catch (err2: any) {
          toast.error(err2.response?.data?.error || "Failed to force-delete");
        }
        return;
      }
      toast.error(data?.error || "Failed to delete");
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Projects</h1>
          <p style={styles.subtitle}>
            Jira-style projects with a unique key (e.g.{" "}
            <code style={styles.code}>WEB</code>). Tasks in a project get a
            stable issue id like <code style={styles.code}>WEB-123</code>.
          </p>
        </div>
        <div style={styles.headerActions}>
          <label style={styles.toggle}>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Show archived
          </label>
          {canEdit && (
            <button style={styles.primaryBtn} onClick={openCreate}>
              <Plus size={16} /> New project
            </button>
          )}
        </div>
      </header>

      {loading ? (
        <div style={styles.empty}>Loading…</div>
      ) : projects.length === 0 ? (
        <EmptyState canEdit={canEdit} onCreate={openCreate} />
      ) : (
        <>
          <div style={styles.grid}>
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                canEdit={canEdit}
                canDelete={canDelete}
                isSelected={selectedId === p.id}
                onSelect={() =>
                  setSelectedId(selectedId === p.id ? null : p.id)
                }
                onEdit={() => openEdit(p)}
                onArchive={() => onArchive(p)}
                onDelete={() => onDelete(p)}
              />
            ))}
          </div>
          <Pagination
            total={pageTotal}
            limit={pageLimit}
            offset={pageOffset}
            onPageChange={setPageOffset}
            onLimitChange={setPageLimit}
            pageSizeOptions={[6, 12, 24, 48]}
            itemLabel="project"
          />
        </>
      )}

      {selectedId && (
        <ProjectTasksPanel
          projectId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}

      {showForm && (
        <ProjectForm
          project={editing}
          users={users}
          onClose={() => setShowForm(false)}
          onSaved={async () => {
            setShowForm(false);
            await queryClient.invalidateQueries({
              queryKey: ["admin", "projects"],
            });
          }}
        />
      )}
    </div>
  );
}

interface ProjectCardProps {
  project: any;
  canEdit: boolean;
  canDelete: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

function ProjectCard({
  project: p,
  canEdit,
  canDelete,
  isSelected,
  onSelect,
  onEdit,
  onArchive,
  onDelete,
}: ProjectCardProps) {
  const lead = p.lead_name || p.lead_username || "—";
  return (
    <div
      style={{
        ...styles.card,
        opacity: p.is_archived ? 0.55 : 1,
        outline: isSelected ? `2px solid ${p.color}` : "none",
      }}
    >
      <button style={styles.cardMain} onClick={onSelect}>
        <div style={styles.keyBadge(p.color)}>
          <Folder size={14} />
          <span style={styles.keyText}>{p.key}</span>
        </div>
        <div style={styles.cardBody}>
          <h3 style={styles.cardTitle}>{p.name}</h3>
          {p.description && <p style={styles.cardDesc}>{p.description}</p>}
          <div style={styles.cardMeta}>
            <span>
              Lead: <strong>{lead}</strong>
            </span>
            <span>•</span>
            <span>
              {p.task_count} task{p.task_count !== 1 ? "s" : ""}
            </span>
            <span>•</span>
            <span>
              Next:{" "}
              <code style={styles.codeSm}>
                {p.key}-{p.next_task_number}
              </code>
            </span>
          </div>
        </div>
      </button>
      {canEdit && (
        <div style={styles.cardActions}>
          <button title="Edit" style={styles.iconBtn} onClick={onEdit}>
            <Edit3 size={14} />
          </button>
          <button
            title={p.is_archived ? "Unarchive" : "Archive"}
            style={styles.iconBtn}
            onClick={onArchive}
          >
            {p.is_archived ? (
              <ArchiveRestore size={14} />
            ) : (
              <Archive size={14} />
            )}
          </button>
          {canDelete && (
            <button
              title="Delete"
              style={{ ...styles.iconBtn, color: "#ef4444" }}
              onClick={onDelete}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface ProjectFormProps {
  project: any;
  users: any[];
  onClose: () => void;
  onSaved: () => void;
}

function ProjectForm({ project, users, onClose, onSaved }: ProjectFormProps) {
  const toast = useToast() as any;
  const isEdit = !!project;
  const [name, setName] = useState(project?.name || "");
  const [keyValue, setKeyValue] = useState(project?.key || "");
  const [description, setDescription] = useState(project?.description || "");
  const [color, setColor] = useState(project?.color || COLORS[0]);
  const [leadId, setLeadId] = useState(project?.lead_user_id || "");
  const [saving, setSaving] = useState(false);

  const keyValid = useMemo(
    () => isEdit || KEY_RE.test(keyValue),
    [keyValue, isEdit],
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!isEdit && !keyValid) {
      toast.error(
        "Key must be 2–10 uppercase letters/digits/underscores, starting with a letter.",
      );
      return;
    }
    const payload: any = {
      name: name.trim(),
      description: description.trim() || null,
      color,
      lead_user_id: leadId || null,
    };
    if (!isEdit) payload.key = keyValue.trim().toUpperCase();
    try {
      setSaving(true);
      if (isEdit) await updateProject(project.id, payload);
      else await createProject(payload);
      toast.success(isEdit ? "Project updated" : "Project created");
      onSaved();
    } catch (err: any) {
      toast.error(err.response?.data?.error || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header style={styles.modalHeader}>
          <h2 style={{ margin: 0 }}>
            {isEdit ? `Edit ${project.key}` : "New project"}
          </h2>
          <button style={styles.iconBtn} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <form onSubmit={onSubmit} style={styles.form}>
          <label style={styles.label}>
            <span>Name</span>
            <input
              style={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Website Rewrite"
              maxLength={200}
              autoFocus
              required
            />
          </label>
          {!isEdit && (
            <label style={styles.label}>
              <span>Key</span>
              <input
                style={{
                  ...styles.input,
                  fontFamily: "monospace",
                  textTransform: "uppercase",
                }}
                value={keyValue}
                onChange={(e) =>
                  setKeyValue(
                    e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""),
                  )
                }
                placeholder="WEB"
                maxLength={10}
                required
              />
              <small style={styles.hint}>
                2–10 chars, uppercase letters/digits/underscores. Used in
                branches:{" "}
                <code style={styles.codeSm}>
                  feature/{keyValue || "WEB"}-123-…
                </code>
                . Cannot be changed later.
              </small>
              {keyValue && !keyValid && (
                <small style={{ ...styles.hint, color: "#ef4444" }}>
                  Must start with a letter; only A–Z, 0–9, and underscores.
                </small>
              )}
            </label>
          )}
          <label style={styles.label}>
            <span>Description</span>
            <textarea
              style={{ ...styles.input, minHeight: 70, resize: "vertical" }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional: what this project is about."
              maxLength={2000}
            />
          </label>
          <label style={styles.label}>
            <span>Lead</span>
            <select
              style={styles.input}
              value={leadId || ""}
              onChange={(e) => setLeadId(e.target.value)}
            >
              <option value="">— None —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name || u.username}
                </option>
              ))}
            </select>
          </label>
          <label style={styles.label}>
            <span>Colour</span>
            <div style={styles.colors}>
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={c}
                  style={{
                    ...styles.colorChip,
                    background: c,
                    outline:
                      c === color ? `2px solid var(--accent, #2383e2)` : "none",
                  }}
                />
              ))}
            </div>
          </label>
          <footer style={styles.modalFooter}>
            <button type="button" style={styles.secondaryBtn} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" style={styles.primaryBtn} disabled={saving}>
              {saving ? "Saving…" : isEdit ? "Save" : "Create"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

interface ProjectTasksPanelProps {
  projectId: any;
  onClose: () => void;
}

function ProjectTasksPanel({ projectId, onClose }: ProjectTasksPanelProps) {
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);

  // Reset paging whenever we switch project or change page size.
  useEffect(() => {
    setOffset(0);
  }, [projectId, limit]);

  const { data: tasksData, isLoading: loading } = useQuery({
    queryKey: ["admin", "project-tasks", projectId, limit, offset],
    queryFn: async () => {
      const d = (await getProjectTasks(projectId, { limit, offset } as any))
        .data as any;
      return {
        tasks: (d?.tasks as any[]) || [],
        total: d?.pagination?.total ?? (d?.tasks?.length || 0),
      };
    },
  });
  const tasks = tasksData?.tasks ?? EMPTY_TASKS;
  const total = tasksData?.total ?? 0;

  return (
    <div style={styles.panel}>
      <header style={styles.panelHeader}>
        <strong>Tasks in this project</strong>
        <button style={styles.iconBtn} onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      {loading ? (
        <div style={{ padding: 16 }}>Loading…</div>
      ) : tasks.length === 0 ? (
        <div style={{ padding: 16, color: "#9ca3af" }}>
          No tasks yet. Create a task and assign it to this project.
        </div>
      ) : (
        <>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Key</th>
                <th style={styles.th}>Title</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Assignee</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td style={styles.tdKey}>
                    {/* Issue keys link straight to the Tasks page with the
                                            ticket detail modal pre-opened (see Tasks.jsx which
                                            reads ?task=<id> on mount). */}
                    <Link
                      to={`/tasks?task=${t.id}`}
                      style={styles.taskLink}
                      title={`Open ${t.issue_key || `#${t.id}`}`}
                    >
                      <code>{t.issue_key || `#${t.id}`}</code>
                    </Link>
                  </td>
                  <td style={styles.td}>
                    <Link to={`/tasks?task=${t.id}`} style={styles.taskLink}>
                      {t.title}
                    </Link>
                  </td>
                  <td style={styles.td}>{t.status}</td>
                  <td style={styles.td}>
                    {t.assignee?.full_name || t.assignee?.username || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            total={total}
            limit={limit}
            offset={offset}
            onPageChange={setOffset}
            onLimitChange={setLimit}
            pageSizeOptions={[10, 25, 50, 100]}
            compact
            itemLabel="task"
          />
        </>
      )}
    </div>
  );
}

interface EmptyStateProps {
  canEdit: boolean;
  onCreate: () => void;
}

function EmptyState({ canEdit, onCreate }: EmptyStateProps) {
  return (
    <div style={styles.emptyState}>
      <Folder size={48} style={{ color: "#9ca3af" }} />
      <h2 style={{ margin: "12px 0 4px" }}>No projects yet</h2>
      <p style={{ color: "#9ca3af", margin: "0 0 16px" }}>
        Group related tasks under a project to get Jira-style issue keys like{" "}
        <code style={styles.code}>WEB-123</code>.
      </p>
      {canEdit && (
        <button style={styles.primaryBtn} onClick={onCreate}>
          <Plus size={16} /> Create your first project
        </button>
      )}
    </div>
  );
}

// Inline style objects keep this single-file. They reuse the global `--accent`
// / dark-mode variables already defined in client/src/global.css.
const styles: Record<string, any> = {
  page: { maxWidth: 1100, margin: "0 auto", padding: "24px 16px" },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
    gap: 16,
    flexWrap: "wrap",
  },
  title: { margin: 0, fontSize: 24, fontWeight: 700 },
  subtitle: {
    margin: "6px 0 0",
    color: "var(--text-secondary, #9ca3af)",
    fontSize: 13,
    maxWidth: 600,
  },
  headerActions: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    flexWrap: "wrap",
  },
  toggle: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    fontSize: 13,
    color: "var(--text-secondary, #9ca3af)",
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
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid var(--border, #2a2f3a)",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontWeight: 500,
    fontSize: 13,
  },
  iconBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    padding: 0,
    borderRadius: 6,
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
  },
  empty: {
    padding: 48,
    textAlign: "center",
    color: "var(--text-secondary, #9ca3af)",
  },
  emptyState: {
    padding: 64,
    textAlign: "center",
    border: "1px dashed var(--border, #2a2f3a)",
    borderRadius: 12,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
    gap: 12,
  },
  card: {
    display: "flex",
    alignItems: "stretch",
    border: "1px solid var(--border, #2a2f3a)",
    borderRadius: 12,
    background: "var(--card-bg, #1a1d24)",
    overflow: "hidden",
    transition: "transform 0.1s",
  },
  cardMain: {
    flex: 1,
    display: "flex",
    gap: 12,
    padding: 14,
    textAlign: "left",
    background: "transparent",
    border: "none",
    color: "inherit",
    cursor: "pointer",
  },
  cardBody: { flex: 1, minWidth: 0 },
  cardTitle: { margin: 0, fontSize: 15, fontWeight: 600 },
  cardDesc: {
    margin: "4px 0 0",
    fontSize: 12,
    color: "var(--text-secondary, #9ca3af)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
  },
  cardMeta: {
    display: "flex",
    gap: 6,
    fontSize: 11,
    color: "var(--text-secondary, #9ca3af)",
    marginTop: 8,
    flexWrap: "wrap",
    alignItems: "center",
  },
  cardActions: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    padding: "8px 4px",
    borderLeft: "1px solid var(--border, #2a2f3a)",
  },
  keyBadge: (color: string): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "6px 8px",
    borderRadius: 6,
    background: color + "22",
    color,
    fontWeight: 700,
    fontSize: 11,
    alignSelf: "flex-start",
    whiteSpace: "nowrap",
    fontFamily: "monospace",
  }),
  keyText: { letterSpacing: 0.5 },
  label: { display: "flex", flexDirection: "column", gap: 6, fontSize: 13 },
  input: {
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--border, #2a2f3a)",
    background: "var(--input-bg, #0f1115)",
    color: "inherit",
    fontSize: 13,
  },
  hint: { fontSize: 11, color: "var(--text-secondary, #9ca3af)" },
  colors: { display: "flex", gap: 6, flexWrap: "wrap" },
  colorChip: {
    width: 24,
    height: 24,
    borderRadius: "50%",
    border: "none",
    cursor: "pointer",
    outlineOffset: 2,
  },
  // Solid backdrop + opaque modal so the inline-style page (which has no
  // theme variables wired in light mode) doesn't bleed page content through.
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
    marginTop: 8,
  },
  form: { display: "flex", flexDirection: "column", gap: 14, padding: 16 },
  panel: {
    marginTop: 20,
    border: "1px solid var(--border, #2a2f3a)",
    borderRadius: 12,
    background: "var(--card-bg, #1a1d24)",
  },
  panelHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 14px",
    borderBottom: "1px solid var(--border, #2a2f3a)",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "8px 12px",
    fontWeight: 600,
    color: "var(--text-secondary, #9ca3af)",
    borderBottom: "1px solid var(--border, #2a2f3a)",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  td: {
    padding: "8px 12px",
    borderBottom: "1px solid var(--border-subtle, #1f232b)",
  },
  tdKey: {
    padding: "8px 12px",
    borderBottom: "1px solid var(--border-subtle, #1f232b)",
    fontFamily: "monospace",
    fontSize: 12,
  },
  code: {
    padding: "1px 5px",
    borderRadius: 4,
    background: "rgba(255,255,255,0.08)",
    fontFamily: "monospace",
    fontSize: 12,
  },
  codeSm: {
    padding: "1px 4px",
    borderRadius: 3,
    background: "rgba(255,255,255,0.08)",
    fontFamily: "monospace",
    fontSize: 11,
  },
  taskLink: {
    color: "var(--accent, #2383e2)",
    textDecoration: "none",
    cursor: "pointer",
  },
};
