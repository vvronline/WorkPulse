import { useState, useMemo, useRef } from "react";
import ReactQuill from "react-quill-new";
import DOMPurify from "dompurify";
import { Paperclip, X } from "lucide-react";
import hljs from "../../hljs-setup";
import MentionInput from "../common/MentionInput";
import CommentAttachment from "../common/CommentAttachment";
import s from "./CommentSection.module.css";

interface CommentUser {
    id: number | string;
    username?: string;
    full_name?: string;
    [key: string]: unknown;
}

interface CommentItem {
    id: number | string;
    user_id?: number | string;
    content?: string;
    avatar?: string;
    full_name?: string;
    username?: string;
    created_at?: string;
    updated_at?: string;
    [key: string]: unknown;
}

const DOMPURIFY_CONFIG = {
    ALLOWED_TAGS: [
        "b",
        "i",
        "em",
        "strong",
        "a",
        "code",
        "pre",
        "ul",
        "ol",
        "li",
        "p",
        "br",
        "span",
    ],
    ALLOWED_ATTR: ["href", "title", "target", "rel", "class"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP: /^(?:(?:f|ht)tps?|mailto|tel):/i,
};

const COMMENT_QUILL_MODULES = {
    toolbar: [
        ["bold", "italic", "underline", "strike"],
        ["code-block"],
        [{ list: "ordered" }, { list: "bullet" }],
        ["link"],
        ["clean"],
    ],
    syntax: { highlight: (text: string) => hljs.highlightAuto(text).value },
};

function highlightHtml(raw?: string): string {
    if (!raw) return "";
    const clean = DOMPurify.sanitize(raw, DOMPURIFY_CONFIG);
    const highlighted = clean.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (match, code) => {
        const txt = code
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"');
        try {
            const result = hljs.highlightAuto(txt);
            return `<pre class="hljs">${result.value}</pre>`;
        } catch {
            return match;
        }
    });
    // Re-sanitize after hljs mutation to prevent entity-decode XSS
    return DOMPurify.sanitize(highlighted, DOMPURIFY_CONFIG);
}

interface HighlightedHtmlProps extends React.HTMLAttributes<HTMLDivElement> {
    html?: string;
    className?: string;
}

function HighlightedHtml({ html, className, ...rest }: HighlightedHtmlProps) {
    const highlighted = useMemo(() => highlightHtml(html), [html]);
    return (
        <div className={className} dangerouslySetInnerHTML={{ __html: highlighted }} {...rest} />
    );
}

function stripHtml(html?: string): string {
    if (!html) return "";
    const tmp = document.createElement("div");
    tmp.innerHTML = DOMPurify.sanitize(html, DOMPURIFY_CONFIG);
    return tmp.textContent || tmp.innerText || "";
}

function getAvatarUrl(avatar?: string): string {
    if (!avatar) return "";
    return avatar.startsWith("/") ? avatar : `/uploads/avatars/${avatar}`;
}

interface CommentSectionProps {
    comments: CommentItem[];
    loading?: boolean;
    currentUserId?: number | string;
    users?: CommentUser[];
    onAdd: (content: string, file: File | null) => Promise<void> | void;
    onEdit: (commentId: number | string, content: string) => Promise<void> | void;
    onDelete: (commentId: number | string) => void;
}

/**
 * Reusable comment section with inline editing and @mention support.
 */
export default function CommentSection({
    comments,
    loading,
    currentUserId,
    users = [],
    onAdd,
    onEdit,
    onDelete,
}: CommentSectionProps) {
    const [commentText, setCommentText] = useState("");
    const strippedCommentText = useMemo(() => stripHtml(commentText), [commentText]);
    const [editingId, setEditingId] = useState<number | string | null>(null);
    const [editText, setEditText] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const handleAdd = async () => {
        if (!strippedCommentText.trim() && !file) return;
        await onAdd(commentText, file);
        setCommentText("");
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        if (f) setFile(f);
    };

    const handleEdit = async (id: number | string) => {
        if (!stripHtml(editText).trim()) return;
        await onEdit(id, editText);
        setEditingId(null);
        setEditText("");
    };

    return (
        <>
            {loading && (
                <div className="loading-spinner">
                    <div className="spinner" />
                </div>
            )}
            <div className={s["detail-comment-list"]}>
                {comments.length === 0 && !loading && (
                    <div className={s["comment-empty"]}>
                        No comments yet. Start the conversation!
                    </div>
                )}
                {comments.map((c) => (
                    <div key={c.id} className={s["comment-item"]}>
                        <div className={s["comment-meta"]}>
                            {c.avatar ? (
                                <img
                                    src={getAvatarUrl(c.avatar)}
                                    alt=""
                                    className={s["comment-avatar"]}
                                />
                            ) : (
                                <span className={s["comment-avatar-placeholder"]}>
                                    {(c.full_name || c.username || "?")[0].toUpperCase()}
                                </span>
                            )}
                            <strong>{c.full_name || c.username}</strong>
                            <span className={s["comment-time"]}>
                                {new Date(c.created_at ?? "").toLocaleString()}
                            </span>
                            {c.updated_at && c.updated_at !== c.created_at && (
                                <span className={s["comment-edited"]}>(edited)</span>
                            )}
                        </div>
                        {editingId === c.id ? (
                            <div className={s["comment-edit"]}>
                                <div className={s["comment-quill-wrapper"]}>
                                    <ReactQuill
                                        theme="snow"
                                        value={editText}
                                        onChange={setEditText}
                                        modules={COMMENT_QUILL_MODULES}
                                        placeholder="Edit comment..."
                                    />
                                </div>
                                <div className={s["comment-edit-actions"]}>
                                    <button
                                        className="btn btn-primary btn-sm"
                                        onClick={() => handleEdit(c.id)}
                                    >
                                        Save
                                    </button>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => setEditingId(null)}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <>
                                {c.content && (
                                    <HighlightedHtml
                                        html={c.content}
                                        className={s["comment-body"]}
                                    />
                                )}
                                <CommentAttachment comment={c} />
                                <div className={s["comment-actions"]}>
                                    {c.user_id === currentUserId && (
                                        <>
                                            {c.content && (
                                                <button
                                                    onClick={() => {
                                                        setEditingId(c.id);
                                                        setEditText(c.content ?? "");
                                                    }}
                                                >
                                                    Edit
                                                </button>
                                            )}
                                            <button onClick={() => onDelete(c.id)}>Delete</button>
                                        </>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                ))}
            </div>
            {file && (
                <div className={s["comment-file-chip"]}>
                    <Paperclip size={13} />
                    <span className={s["comment-file-name"]}>{file.name}</span>
                    <button
                        type="button"
                        className={s["comment-file-remove"]}
                        onClick={() => {
                            setFile(null);
                            if (fileInputRef.current) fileInputRef.current.value = "";
                        }}
                        title="Remove attachment"
                        aria-label="Remove attachment"
                    >
                        <X size={13} />
                    </button>
                </div>
            )}
            <div className={s["comment-input"]}>
                <input
                    ref={fileInputRef}
                    type="file"
                    style={{ display: "none" }}
                    onChange={onPickFile}
                    accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
                />
                <div className={s["comment-quill-wrapper"]}>
                    <MentionInput
                        value={commentText}
                        onChange={setCommentText}
                        users={users}
                        placeholder="Write a comment… (type @ to mention someone)"
                        onSubmit={handleAdd}
                    />
                    <button
                        type="button"
                        className={s["comment-attach-btn"]}
                        onClick={() => fileInputRef.current?.click()}
                        title="Attach a file"
                        aria-label="Attach a file"
                    >
                        <Paperclip size={16} />
                    </button>
                    <button
                        className={`${s["comment-send-fab"]} btn btn-primary btn-sm`}
                        onClick={handleAdd}
                        disabled={!stripHtml(commentText).trim() && !file}
                        title="Send comment"
                        aria-label="Send comment"
                    >
                        ➤
                    </button>
                </div>
                <button
                    className={`btn btn-primary btn-sm ${s["comment-send-desktop"]}`}
                    onClick={handleAdd}
                    disabled={!stripHtml(commentText).trim() && !file}
                >
                    Send
                </button>
            </div>
        </>
    );
}