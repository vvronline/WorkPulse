import React, { useState, useRef } from "react";
import ReactQuill from "react-quill-new";
import "react-quill-new/dist/quill.snow.css";
import { COMMENT_QUILL_MODULES } from "./constants";
import { HighlightedHtml, stripHtml, getAvatarUrl } from "./utils";
import { MessageSquare, X, Paperclip } from "lucide-react";
import CommentAttachment from "../../components/common/CommentAttachment";
import s from "./InlineCommentPanel.module.css";

interface InlineCommentPanelProps {
    task: any;
    comments: any[];
    commentsLoading: boolean;
    commentText: string;
    setCommentText: (v: string) => void;
    editingCommentId: number | string | null;
    setEditingCommentId: (id: number | string | null) => void;
    editCommentText: string;
    setEditCommentText: (v: string) => void;
    currentUser: any;
    onClose: () => void;
    onAddComment: (file: File | null) => void | Promise<void>;
    onEditComment: (id: number | string) => void;
    onDeleteComment: (id: number | string) => void;
}

export default function InlineCommentPanel({
    task,
    comments,
    commentsLoading,
    commentText,
    setCommentText,
    editingCommentId,
    setEditingCommentId,
    editCommentText,
    setEditCommentText,
    currentUser,
    onClose,
    onAddComment,
    onEditComment,
    onDeleteComment,
}: InlineCommentPanelProps) {
    const [file, setFile] = useState<File | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    if (!task) return null;

    const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        if (f) setFile(f);
    };

    const handleSend = async () => {
        if (!stripHtml(commentText).trim() && !file) return;
        await onAddComment(file);
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    return (
        <div className={s["comment-overlay"]} onClick={onClose}>
            <div className={s["comment-panel"]} onClick={(e) => e.stopPropagation()}>
                <div className={s["comment-panel-header"]}>
                    <h3>
                        <MessageSquare
                            size={16}
                            style={{ marginRight: 6, verticalAlign: "middle" }}
                        />
                        Comments — {task.title}
                    </h3>
                    <button className={s["close-form-btn"]} onClick={onClose}>
                        <X size={16} />
                    </button>
                </div>

                <div className={s["comment-list"]}>
                    {commentsLoading && (
                        <div className="loading-spinner">
                            <div className="spinner" />
                        </div>
                    )}
                    {!commentsLoading && comments.length === 0 && (
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
                                    {new Date(c.created_at).toLocaleString()}
                                </span>
                                {c.updated_at && c.updated_at !== c.created_at && (
                                    <span className={s["comment-edited"]}>(edited)</span>
                                )}
                            </div>

                            {editingCommentId === c.id ? (
                                <div className={s["comment-edit"]}>
                                    <div className={s["comment-quill-wrapper"]}>
                                        <ReactQuill
                                            theme="snow"
                                            value={editCommentText}
                                            onChange={setEditCommentText}
                                            modules={COMMENT_QUILL_MODULES}
                                            placeholder="Edit comment..."
                                        />
                                    </div>
                                    <div className={s["comment-edit-actions"]}>
                                        <button
                                            className="btn btn-primary btn-sm"
                                            onClick={() => onEditComment(c.id)}
                                        >
                                            Save
                                        </button>
                                        <button
                                            className="btn btn-secondary btn-sm"
                                            onClick={() => setEditingCommentId(null)}
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
                                        {c.user_id === currentUser?.id && c.content && (
                                            <button
                                                onClick={() => {
                                                    setEditingCommentId(c.id);
                                                    setEditCommentText(c.content);
                                                }}
                                            >
                                                Edit
                                            </button>
                                        )}
                                        {c.user_id === currentUser?.id && (
                                            <button onClick={() => onDeleteComment(c.id)}>
                                                Delete
                                            </button>
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
                        <ReactQuill
                            theme="snow"
                            value={commentText}
                            onChange={setCommentText}
                            modules={COMMENT_QUILL_MODULES}
                            placeholder="Write a comment..."
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
                            onClick={handleSend}
                            disabled={!stripHtml(commentText).trim() && !file}
                            title="Send comment"
                            aria-label="Send comment"
                        >
                            ➤
                        </button>
                    </div>
                    <button
                        className={`btn btn-primary btn-sm ${s["comment-send-desktop"]}`}
                        onClick={handleSend}
                        disabled={!stripHtml(commentText).trim() && !file}
                    >
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}