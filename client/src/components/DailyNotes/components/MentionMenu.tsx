/* eslint-disable @typescript-eslint/no-explicit-any */
/* MentionMenu — Quill-integrated @mention dropdown.
   Shows a filtered list of team members when the user types '@'.
   Inserts a styled mention chip (MentionBlot) on selection.
   Fires a callback so the parent can send a notification. */
import React, { useState, useEffect, useRef, useCallback } from "react";
import s from "./MentionMenu.module.css";

interface MentionUser {
    id: string | number;
    full_name?: string;
    username?: string;
    avatar?: string;
    [key: string]: unknown;
}

interface MentionMenuProps {
    quillRef: React.RefObject<any>;
    pageId: string;
    resetKey?: number;
    users: MentionUser[];
    onMention?: (user: MentionUser) => void;
}

function getEditor(ref: React.RefObject<any> | undefined): any {
    const node = ref?.current;
    if (!node) return null;
    return typeof node.getEditor === "function" ? node.getEditor() : node;
}

export default function MentionMenu({ quillRef, pageId, resetKey, users, onMention }: MentionMenuProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [position, setPosition] = useState({ top: 0, left: 0 });
    const [selectedIndex, setSelectedIndex] = useState(0);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const triggerIndexRef = useRef<number | null>(null); // character index where '@' was typed

    const filtered = users.filter(u => {
        if (!query) return true;
        const q = query.toLowerCase();
        return (
            (u.full_name || "").toLowerCase().includes(q) ||
            (u.username || "").toLowerCase().includes(q)
        );
    }).slice(0, 8);

    const closeMention = useCallback(() => {
        setOpen(false);
        setQuery("");
        setSelectedIndex(0);
        triggerIndexRef.current = null;
    }, []);

    const insertMention = useCallback((user: MentionUser) => {
        const quill = getEditor(quillRef);
        if (!quill || triggerIndexRef.current === null) return;

        const start = triggerIndexRef.current;
        // Delete the '@' + query text
        const deleteLen = 1 + query.length;
        quill.deleteText(start, deleteLen, "user");

        // Insert the mention blot
        quill.insertEmbed(start, "mention", {
            id: user.id,
            name: user.full_name || user.username,
            avatar: user.avatar,
        }, "user");

        // Add a space after the mention
        quill.insertText(start + 1, " ", "user");
        quill.setSelection(start + 2, 0, "user");

        // Notify parent to send notification
        if (onMention) onMention(user);

        closeMention();
    }, [quillRef, query, onMention, closeMention]);

    useEffect(() => {
        const quill = getEditor(quillRef);
        if (!quill) return;

        const onTextChange = (delta: any, oldDelta: any, source: string) => {
            if (source !== "user") return;

            const selection = quill.getSelection();
            if (!selection) return;

            const cursorIndex = selection.index;
            const text = quill.getText(0, cursorIndex);

            // Find the last '@' that isn't inside a word
            const lastAt = text.lastIndexOf("@");
            if (lastAt === -1) {
                if (open) closeMention();
                return;
            }

            // Check that '@' is at start or preceded by whitespace/newline
            if (lastAt > 0 && !/[\s\n]/.test(text[lastAt - 1])) {
                if (open) closeMention();
                return;
            }

            // The query is everything between '@' and cursor
            const mentionQuery = text.slice(lastAt + 1);

            // Close if query contains whitespace (indicates they moved on)
            if (/\s/.test(mentionQuery)) {
                if (open) closeMention();
                return;
            }

            // Position the menu near the '@' character
            const bounds = quill.getBounds(lastAt);
            if (bounds) {
                setPosition({
                    top: bounds.top + bounds.height + 4,
                    left: bounds.left,
                });
            }

            triggerIndexRef.current = lastAt;
            setQuery(mentionQuery);
            setSelectedIndex(0);
            setOpen(true);
        };

        const onSelectionChange = (range: any) => {
            if (!range && open) {
                closeMention();
            }
        };

        quill.on("text-change", onTextChange);
        quill.on("selection-change", onSelectionChange);

        return () => {
            quill.off("text-change", onTextChange);
            quill.off("selection-change", onSelectionChange);
        };
    }, [quillRef, pageId, resetKey, open, closeMention]);

    // Keyboard navigation
    useEffect(() => {
        if (!open) return;
        const quill = getEditor(quillRef);
        if (!quill) return;

        const handler = (e: KeyboardEvent) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIndex(i => (i + 1) % Math.max(filtered.length, 1));
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex(i => (i - 1 + filtered.length) % Math.max(filtered.length, 1));
            } else if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                if (filtered[selectedIndex]) {
                    insertMention(filtered[selectedIndex]);
                }
            } else if (e.key === "Escape") {
                e.preventDefault();
                closeMention();
            }
        };

        quill.root.addEventListener("keydown", handler);
        return () => quill.root.removeEventListener("keydown", handler);
    }, [open, quillRef, filtered, selectedIndex, insertMention, closeMention]);

    // Scroll selected item into view
    useEffect(() => {
        if (!open || !menuRef.current) return;
        const item = menuRef.current.children[selectedIndex] as HTMLElement | undefined;
        if (item) item.scrollIntoView({ block: "nearest" });
    }, [selectedIndex, open]);

    if (!open || filtered.length === 0) return null;

    return (
        <div
            ref={menuRef}
            className={s.menu}
            style={{ top: position.top, left: position.left }}
        >
            {filtered.map((user, i) => (
                <div
                    key={user.id}
                    className={`${s.item} ${i === selectedIndex ? s.selected : ""}`}
                    onMouseDown={(e) => {
                        e.preventDefault(); // prevent blur
                        insertMention(user);
                    }}
                    onMouseEnter={() => setSelectedIndex(i)}
                >
                    <div className={s.avatar}>
                        {user.avatar ? (
                            <img src={user.avatar} alt="" />
                        ) : (
                            <span>{(user.full_name || user.username || "?").charAt(0).toUpperCase()}</span>
                        )}
                    </div>
                    <div className={s.info}>
                        <span className={s.name}>{user.full_name || user.username}</span>
                        {user.username && <span className={s.username}>@{user.username}</span>}
                    </div>
                </div>
            ))}
        </div>
    );
}