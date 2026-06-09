import { useState, useEffect, useMemo } from "react";
import { File, X, Search, Image, FileText, Film, Music } from "lucide-react";
import s from "./SharedFilesPanel.module.css";
import { getSharedFiles } from "../../api";
import FilePreview from "./FilePreview";

interface SharedFile {
    id: number | string;
    file_url?: string;
    file_name?: string;
    file_type?: string;
    file_size?: number;
    sender_name?: string;
    created_at?: string;
    [key: string]: unknown;
}

const FILE_FILTERS = [
    { key: "all", label: "All" },
    { key: "image", label: "Images", icon: Image },
    { key: "document", label: "Docs", icon: FileText },
    { key: "video", label: "Video", icon: Film },
    { key: "audio", label: "Audio", icon: Music },
];

function getFileCategory(type?: string): string {
    if (!type) return "other";
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    if (type.includes("pdf") || type.includes("document") || type.includes("sheet") || type.includes("text")) return "document";
    return "other";
}

interface FileGroups {
    today: SharedFile[];
    thisWeek: SharedFile[];
    thisMonth: SharedFile[];
    older: SharedFile[];
}

function groupByDate(files: SharedFile[]): FileGroups {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 86400000);
    const monthAgo = new Date(today.getTime() - 30 * 86400000);

    const groups: FileGroups = { today: [], thisWeek: [], thisMonth: [], older: [] };
    for (const f of files) {
        const d = new Date(f.created_at as string);
        if (d >= today) groups.today.push(f);
        else if (d >= weekAgo) groups.thisWeek.push(f);
        else if (d >= monthAgo) groups.thisMonth.push(f);
        else groups.older.push(f);
    }
    return groups;
}

interface SharedFilesPanelProps {
    convId: number | string;
    onClose: () => void;
}

export default function SharedFilesPanel({ convId, onClose }: SharedFilesPanelProps) {
    const [files, setFiles] = useState<SharedFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState("all");
    const [query, setQuery] = useState("");

    useEffect(() => {
        if (!convId) return;
        setLoading(true);
        getSharedFiles(convId)
            .then(({ data }) => setFiles(data as SharedFile[]))
            .catch(() => setFiles([]))
            .finally(() => setLoading(false));
    }, [convId]);

    const filtered = useMemo(() => {
        let result = files;
        if (filter !== "all") {
            result = result.filter(f => getFileCategory(f.file_type) === filter);
        }
        if (query.trim()) {
            const q = query.toLowerCase();
            result = result.filter(f => (f.file_name || "").toLowerCase().includes(q));
        }
        return result;
    }, [files, filter, query]);

    const groups = useMemo(() => groupByDate(filtered), [filtered]);

    const renderGroup = (label: string, items: SharedFile[]) => {
        if (items.length === 0) return null;
        return (
            <div key={label}>
                <div className={s.groupLabel}>{label}</div>
                {items.map(f => (
                    <div key={f.id} className={s.fileItem}>
                        <FilePreview
                            fileUrl={f.file_url as string}
                            fileName={f.file_name}
                            fileType={f.file_type}
                            fileSize={f.file_size}
                        />
                        <div className={s.fileMeta}>
                            <span className={s.sender}>{f.sender_name}</span>
                            <span className={s.date}>
                                {new Date(f.created_at as string).toLocaleDateString([], { month: "short", day: "numeric" })}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    return (
        <div className={s.panel}>
            <div className={s.header}>
                <span className={s.title}><File size={15} /> Shared Files</span>
                <button className={s.closeBtn} onClick={onClose}><X size={16} /></button>
            </div>

            <div className={s.searchWrap}>
                <Search size={14} className={s.searchIcon} />
                <input
                    className={s.searchInput}
                    placeholder="Search files..."
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                />
            </div>

            <div className={s.filters}>
                {FILE_FILTERS.map(f => (
                    <button
                        key={f.key}
                        className={`${s.filterBtn} ${filter === f.key ? s.filterActive : ""}`}
                        onClick={() => setFilter(f.key)}
                    >
                        {f.icon && <f.icon size={12} />}
                        {f.label}
                    </button>
                ))}
            </div>

            <div className={s.list}>
                {loading && <div className={s.empty}>Loading...</div>}
                {!loading && files.length === 0 && (
                    <div className={s.emptyState}>
                        <div className={s.emptyIcon}><File size={32} strokeWidth={1.2} /></div>
                        <p className={s.emptyTitle}>No shared files</p>
                        <p className={s.emptyDesc}>Files shared in this conversation will appear here</p>
                    </div>
                )}
                {!loading && files.length > 0 && filtered.length === 0 && (
                    <div className={s.empty}>No files match your filter</div>
                )}
                {renderGroup("Today", groups.today)}
                {renderGroup("This Week", groups.thisWeek)}
                {renderGroup("This Month", groups.thisMonth)}
                {renderGroup("Older", groups.older)}
            </div>
        </div>
    );
}