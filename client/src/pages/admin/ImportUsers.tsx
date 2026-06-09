import { useState, useRef } from "react";
import { Table2, FolderOpen, AlertTriangle, CheckCircle2, XCircle, Download } from "lucide-react";
import { importUsers } from "../../api";
import s from "./AdminPages.module.css";

interface ImportDetail {
    row: number;
    username: string;
    full_name: string;
    email: string;
    role: string;
    initial_password: string;
    auto_generated?: boolean;
}

interface ImportFailed {
    row: number;
    error: string;
}

interface ImportResult {
    imported: number;
    failed?: ImportFailed[];
    details?: ImportDetail[];
}

function downloadCredentialsCSV(details: ImportDetail[]) {
    const header = "Username,Full Name,Email,Role,Initial Password,Auto-Generated";
    const rows = details.map(d =>
        [d.username, d.full_name, d.email, d.role, d.initial_password, d.auto_generated ? "Yes" : "No"]
            .map(v => `"${String(v ?? "").replace(/"/g, '""')}"`)
            .join(",")
    );
    const csv = [header, ...rows].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `imported_credentials_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

interface FieldDef {
    name: string;
    required: boolean;
    note: string;
}

const FIELDS: FieldDef[] = [
    { name: "username",          required: true,  note: "Unique login name (letters, numbers, _ and - only)" },
    { name: "full_name",         required: true,  note: "Display name" },
    { name: "email",             required: true,  note: "Must be unique" },
    { name: "password",          required: false, note: "Leave blank to auto-generate a temp password" },
    { name: "role",              required: false, note: "employee (default) | team_lead | manager | hr_admin" },
    { name: "department_name",   required: false, note: "Must match an existing department name exactly" },
    { name: "team_name",         required: false, note: "Must match an existing team name exactly" },
    { name: "manager_username",  required: false, note: "Must match an existing user's username" },
];

export default function ImportUsers() {
    const [file, setFile] = useState<File | null>(null);
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<ImportResult | null>(null);
    const [error, setError] = useState("");
    const [dragging, setDragging] = useState(false);
    const fileRef = useRef<HTMLInputElement | null>(null);

    const handleFile = (f?: File) => {
        if (!f) return;
        if (!/\.(csv|json)$/i.test(f.name)) {
            setError("Only .csv or .json files are accepted.");
            return;
        }
        setFile(f);
        setError("");
        setResult(null);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        handleFile(e.dataTransfer.files[0]);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!file) { setError("Please select a .csv or .json file."); return; }
        setError("");
        setResult(null);
        setLoading(true);
        try {
            const formData = new FormData();
            formData.append("file", file);
            const res = await importUsers(formData, true);
            setResult(res.data as ImportResult);
        } catch (err: any) {
            setError(err.response?.data?.error || "Import failed. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className={s.section}>
            <h3 className={s.sectionTitle}>Bulk User Import</h3>
            <p className={s.sectionDesc}>
                Upload a <strong>.csv</strong> or <strong>.json</strong> file to create multiple users at once.
                All imported users will be required to change their password on first login.
                Passwords left blank generate a secure temporary password (shown after import).
            </p>

            {/* ── Field reference ── */}
            <div className={s.card}>
                <h4 className={s.cardTitle}>Supported fields</h4>
                <table className={s.table}>
                    <thead>
                        <tr><th>Field</th><th>Required</th><th>Notes</th></tr>
                    </thead>
                    <tbody>
                        {FIELDS.map(f => (
                            <tr key={f.name}>
                                <td><code>{f.name}</code></td>
                                <td style={{ textAlign: "center" }}>{f.required ? <CheckCircle2 size={14} style={{ color: "var(--success)", verticalAlign: "middle" }} /> : "—"}</td>
                                <td className={s.muted}>{f.note}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <p className={s.hint} style={{ marginTop: 10 }}>Max 200 users per batch.</p>
            </div>

            {/* ── Upload form ── */}
            <form onSubmit={handleSubmit} className={s.importForm}>
                <div
                    className={`${s.dropZone} ${dragging ? s.dropZoneActive : ""} ${file ? s.dropZoneHasFile : ""}`}
                    onDragOver={e => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={handleDrop}
                    onClick={() => fileRef.current?.click()}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => e.key === "Enter" && fileRef.current?.click()}
                >
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".csv,.json"
                        style={{ display: "none" }}
                        onChange={e => handleFile(e.target.files?.[0])}
                    />
                    {file ? (
                        <>
                            <span className={s.dropIcon}>{file.name.endsWith(".json") ? "{ }" : <Table2 size={32} />}</span>
                            <span className={s.dropFileName}>{file.name}</span>
                            <span className={s.dropHint}>Click or drop to replace</span>
                        </>
                    ) : (
                        <>
                            <span className={s.dropIcon}><FolderOpen size={32} /></span>
                            <span className={s.dropPrimary}>Drop your CSV or JSON file here</span>
                            <span className={s.dropHint}>or click to browse</span>
                        </>
                    )}
                </div>

                {error && <p className={s.errorMsg}>{error}</p>}

                <button type="submit" className={s.primaryBtn} disabled={loading || !file}>
                    {loading ? "Importing…" : `Import${file ? ` "${file.name}"` : ""}`}
                </button>
            </form>

            {/* ── Results ── */}
            {result && (
                <div className={s.resultBox}>
                    <h4 className={s.resultTitle}>
                        {result.imported > 0 ? <><CheckCircle2 size={14} style={{ marginRight: 4, verticalAlign: "middle", color: "var(--success)" }} />{result.imported} user{result.imported !== 1 ? "s" : ""} imported</> : ""}
                        {result.imported > 0 && (result.failed?.length ?? 0) > 0 ? " · " : ""}
                        {(result.failed?.length ?? 0) > 0 ? <><XCircle size={14} style={{ marginRight: 4, verticalAlign: "middle", color: "var(--danger)" }} />{result.failed!.length} failed</> : ""}
                    </h4>

                    {(result.failed?.length ?? 0) > 0 && (
                        <div className={s.failedSection}>
                            <h5 className={s.failedTitle}>Failed rows</h5>
                            <table className={s.table}>
                                <thead><tr><th>Row</th><th>Error</th></tr></thead>
                                <tbody>
                                    {result.failed!.map(f => (
                                        <tr key={f.row}>
                                            <td>{f.row}</td>
                                            <td className={s.errorCell}>{f.error}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {(result.details?.length ?? 0) > 0 && (
                        <div className={s.successSection}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                                <h5 className={s.successTitle} style={{ margin: 0 }}>Imported users</h5>
                                <button
                                    type="button"
                                    className={s.secondaryBtn}
                                    onClick={() => downloadCredentialsCSV(result.details!)}
                                >
                                <Download size={14} style={{ marginRight: 5, verticalAlign: "middle" }} />Download credentials CSV
                                </button>
                            </div>
                            <table className={s.table}>
                                <thead>
                                    <tr>
                                        <th>Row</th>
                                        <th>Username</th>
                                        <th>Full Name</th>
                                        <th>Email</th>
                                        <th>Role</th>
                                        <th>Initial Password</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {result.details!.map(d => (
                                        <tr key={d.row}>
                                            <td>{d.row}</td>
                                            <td>{d.username}</td>
                                            <td>{d.full_name}</td>
                                            <td>{d.email}</td>
                                            <td>{d.role}</td>
                                            <td className={s.tempPw}>
                                                <code>{d.initial_password}</code>
                                                {d.auto_generated && (
                                                    <span className={s.muted} style={{ marginLeft: 6, fontStyle: "normal", fontSize: 10 }}>auto</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <p className={s.hint} style={{ marginTop: 8 }}>
                                <AlertTriangle size={13} style={{ marginRight: 5, verticalAlign: "middle", color: "var(--warning)" }} />Save or download these passwords now — they cannot be retrieved after you leave this page.
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}