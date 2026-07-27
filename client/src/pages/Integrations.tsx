// Integrations catalog.
//
// This page is the single hub for connecting AINO with external systems.
// It used to be a one-provider page (GitHub only); it's now a directory that
// groups providers by category (Source Control today; more groups to follow)
// and shows status badges so users can see at a glance which integrations are
// connected, available, or planned.
//
// Adding a new provider
// ─────────────────────
//   1. Build a detail component under `client/src/pages/integrations/` (see
//      `GitHubIntegration.tsx` for the pattern). It receives an
//      `onStatusChange(status)` callback so the catalog card can show a
//      live subtitle (e.g. "Connected as @login").
//   2. Append an entry to PROVIDERS below. Set `status: 'active'` once the
//      provider is wired up, or `'coming_soon'` to render a muted card with
//      a disabled CTA.

import { useState } from "react";
import { useBranding } from "../BrandingContext";
import {
    GitBranch as Github, GitMerge, GitPullRequest,
    ChevronRight, ArrowLeft, CheckCircle2, Clock,
} from "lucide-react";
import GitHubIntegration from "./integrations/GitHubIntegration";

interface Provider {
    id: string;
    name: string;
    group: string;
    description: string;
    icon: any;
    status: "active" | "coming_soon";
    component?: React.ComponentType<any>;
}

// ─── Provider registry ───────────────────────────────────────────────────
//
// Each entry: { id, name, group, description, icon, status, component? }
//   status: 'active' | 'coming_soon'
//   component: React component rendered in the detail view (active only)
const PROVIDERS: Provider[] = [
    {
        id: "github",
        name: "GitHub",
        group: "Source Control",
        description: "Link branches, pull requests, and commits to tasks via issue keys.",
        icon: Github,
        status: "active",
        component: GitHubIntegration,
    },
    {
        id: "gitlab",
        name: "GitLab",
        group: "Source Control",
        description: "Connect GitLab projects and merge requests to your tasks.",
        icon: GitMerge,
        status: "coming_soon",
    },
    {
        id: "bitbucket",
        name: "Bitbucket",
        group: "Source Control",
        description: "Sync Bitbucket repositories, branches, and pull requests.",
        icon: GitPullRequest,
        status: "coming_soon",
    },
];

const GROUP_ORDER = ["Source Control"];

export default function Integrations() {
    const { branding } = useBranding() as any;
    const [selectedId, setSelectedId] = useState<string | null>(null);
    // Live status overlays per-provider, populated by the detail panels via
    // onStatusChange so we can keep the catalog cards' subtitle accurate
    // without re-fetching here.
    const [statusById, setStatusById] = useState<Record<string, any>>({});

    const selected = selectedId
        ? PROVIDERS.find(p => p.id === selectedId) || null
        : null;

    // ─── Detail view ────────────────────────────────────────────────────
    if (selected) {
        const Detail = selected.component as React.ComponentType<any>;
        return (
            <div style={styles.page}>
                <button
                    type="button"
                    style={styles.backBtn}
                    onClick={() => setSelectedId(null)}
                >
                    <ArrowLeft size={14} /> Back to integrations
                </button>
                <Detail
                    onStatusChange={(st: any) =>
                        setStatusById(prev => ({ ...prev, [selected.id]: st }))
                    }
                />
            </div>
        );
    }

    // ─── Catalog view ───────────────────────────────────────────────────
    const grouped = GROUP_ORDER
        .map(group => ({
            group,
            items: PROVIDERS.filter(p => p.group === group),
        }))
        .filter(g => g.items.length > 0);

    return (
        <div style={styles.page}>
            <header style={styles.header}>
                <h1 style={styles.title}>Integrations</h1>
                <p style={styles.subtitle}>
                    Connect {branding?.org_name || "AINO"} with the tools your team already uses. Pick a provider
                    below to configure it. New integrations are added regularly — items marked
                    <em> Coming soon</em> are on the roadmap.
                </p>
            </header>

            {grouped.map(({ group, items }) => (
                <section key={group} style={styles.group}>
                    <h2 style={styles.groupTitle}>{group}</h2>
                    <div style={styles.grid}>
                        {items.map(p => (
                            <ProviderCard
                                key={p.id}
                                provider={p}
                                liveStatus={statusById[p.id]}
                                onOpen={() => setSelectedId(p.id)}
                            />
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}

function ProviderCard({ provider, liveStatus, onOpen }: { provider: Provider; liveStatus?: any; onOpen: () => void }) {
    const Icon = provider.icon;
    const isComingSoon = provider.status === "coming_soon";
    const isConnected = !!liveStatus?.connected;

    let subtitle = provider.description;
    if (isConnected) {
        const login = liveStatus.github_login || liveStatus.login;
        const repoCount = Array.isArray(liveStatus.repos) ? liveStatus.repos.length : null;
        if (login) {
            subtitle = `Connected as @${login}`;
            if (repoCount !== null) {
                subtitle += ` · ${repoCount} repo${repoCount === 1 ? "" : "s"}`;
            }
        } else {
            subtitle = "Connected";
        }
    }

    return (
        <button
            type="button"
            onClick={isComingSoon ? undefined : onOpen}
            disabled={isComingSoon}
            style={{
                ...styles.card,
                ...(isComingSoon ? styles.cardDisabled : null),
            }}
            title={isComingSoon ? "Coming soon" : `Configure ${provider.name}`}
        >
            <div style={styles.cardHead}>
                <div style={styles.cardLogo}><Icon size={20} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.cardName}>{provider.name}</div>
                    <div style={styles.cardDesc}>{subtitle}</div>
                </div>
                {!isComingSoon && (
                    <ChevronRight size={16} style={{ color: "var(--text-secondary, #9ca3af)", flexShrink: 0 }} />
                )}
            </div>
            <div style={styles.cardFoot}>
                {isComingSoon ? (
                    <span style={{ ...styles.badge, ...styles.badgeSoon }}>
                        <Clock size={11} /> Coming soon
                    </span>
                ) : isConnected ? (
                    <span style={{ ...styles.badge, ...styles.badgeConnected }}>
                        <CheckCircle2 size={11} /> Connected
                    </span>
                ) : (
                    <span style={{ ...styles.badge, ...styles.badgeIdle }}>
                        Not connected
                    </span>
                )}
            </div>
        </button>
    );
}

const styles: Record<string, React.CSSProperties> = {
    page: { maxWidth: 980, margin: "0 auto", padding: "24px 16px" },
    header: { marginBottom: 24 },
    title: { margin: 0, fontSize: 24, fontWeight: 700 },
    subtitle: { margin: "6px 0 0", color: "var(--text-secondary, #9ca3af)", fontSize: 13, maxWidth: 680, lineHeight: 1.5 },

    group: { marginTop: 28 },
    groupTitle: {
        margin: "0 0 12px",
        fontSize: 12,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-secondary, #9ca3af)",
    },
    grid: {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 12,
    },

    card: {
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 16,
        borderRadius: 12,
        border: "1px solid var(--border, #2a2f3a)",
        background: "var(--card-bg, #1a1d24)",
        color: "inherit",
        textAlign: "left",
        cursor: "pointer",
        transition: "border-color 0.15s ease, transform 0.15s ease",
        font: "inherit",
    },
    cardDisabled: {
        cursor: "not-allowed",
        opacity: 0.6,
    },
    cardHead: { display: "flex", alignItems: "center", gap: 12 },
    cardLogo: {
        width: 36, height: 36,
        display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: 8,
        background: "rgba(255,255,255,0.06)",
        flexShrink: 0,
    },
    cardName: { fontSize: 14, fontWeight: 600, marginBottom: 2 },
    cardDesc: {
        fontSize: 12,
        color: "var(--text-secondary, #9ca3af)",
        lineHeight: 1.4,
        overflow: "hidden",
        textOverflow: "ellipsis",
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
    },
    cardFoot: { display: "flex", alignItems: "center" },

    badge: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.2,
    },
    badgeConnected: {
        background: "rgba(34,197,94,0.12)",
        color: "#22c55e",
        border: "1px solid rgba(34,197,94,0.25)",
    },
    badgeIdle: {
        background: "rgba(255,255,255,0.05)",
        color: "#9ca3af",
        border: "1px solid var(--border, #2a2f3a)",
    },
    badgeSoon: {
        background: "rgba(245,158,11,0.10)",
        color: "#f59e0b",
        border: "1px solid rgba(245,158,11,0.25)",
    },

    backBtn: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderRadius: 8,
        border: "1px solid var(--border, #2a2f3a)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 500,
        marginBottom: 16,
    },
};