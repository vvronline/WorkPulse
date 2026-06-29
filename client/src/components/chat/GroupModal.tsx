import { useState, useCallback } from "react";
import { X, Crown, Shield, MoreVertical, LogOut } from "lucide-react";
import {
    searchChatUsers,
    createGroup,
    updateGroup,
    leaveGroup,
    setGroupRole,
    transferGroupOwner,
} from "../../api";
import ChatAvatar from "./ChatAvatar";
import s from "./GroupModal.module.css";

type GroupRole = "owner" | "admin" | "member";

interface GroupUser {
    id: number | string;
    full_name?: string;
    avatar?: string;
    role?: GroupRole;
    [key: string]: unknown;
}

interface GroupModalProps {
    existingGroup?: {
        id: number | string;
        group_name?: string;
        group_description?: string | null;
        my_role?: GroupRole;
        [key: string]: unknown;
    } | null;
    members?: GroupUser[];
    /** Current user's id — used to hide self-targeted role controls. */
    currentUserId?: number | string;
    onClose: () => void;
    onSuccess?: () => void;
}

export default function GroupModal({
    existingGroup,
    members: existingMembers,
    currentUserId,
    onClose,
    onSuccess,
}: GroupModalProps) {
    const isEdit = !!existingGroup;
    const [name, setName] = useState(existingGroup?.group_name || "");
    const [description, setDescription] = useState(
        (existingGroup?.group_description as string) || "",
    );
    const [search, setSearch] = useState("");
    const [searchResults, setSearchResults] = useState<GroupUser[]>([]);
    const [selected, setSelected] = useState<GroupUser[]>(existingMembers || []);
    const [saving, setSaving] = useState(false);
    const [menuFor, setMenuFor] = useState<number | string | null>(null);

    // The caller's local role drives which management controls are shown.
    const myRole: GroupRole = (existingGroup?.my_role as GroupRole) || "member";
    const isAdminish = myRole === "owner" || myRole === "admin";
    const isOwner = myRole === "owner";

    const doSearch = useCallback(
        async (q: string) => {
            if (!q || q.length < 2) {
                setSearchResults([]);
                return;
            }
            try {
                const { data } = await searchChatUsers(q);
                setSearchResults(
                    (data as GroupUser[]).filter(
                        (u) => !selected.some((sel) => sel.id === u.id),
                    ),
                );
            } catch {
                setSearchResults([]);
            }
        },
        [selected],
    );

    const addUser = (user: GroupUser) => {
        setSelected((prev) => [...prev, { ...user, role: "member" }]);
        setSearchResults((prev) => prev.filter((u) => u.id !== user.id));
        setSearch("");
    };

    const removeUser = (userId: number | string) => {
        setSelected((prev) => prev.filter((u) => u.id !== userId));
    };

    // ── Live per-member role actions (edit mode only) ──
    const changeRole = async (userId: number | string, role: "admin" | "member") => {
        if (!isEdit) return;
        try {
            await setGroupRole(existingGroup!.id, userId, role);
            setSelected((prev) =>
                prev.map((u) => (u.id === userId ? { ...u, role } : u)),
            );
            onSuccess?.();
        } catch {
            /* surfaced upstream */
        }
        setMenuFor(null);
    };

    const makeOwner = async (userId: number | string) => {
        if (!isEdit) return;
        if (!window.confirm("Transfer ownership to this member? You will become an admin.")) return;
        try {
            await transferGroupOwner(existingGroup!.id, userId);
            onSuccess?.();
            onClose();
        } catch {
            /* surfaced upstream */
        }
    };

    const doLeave = async () => {
        if (!isEdit) return;
        if (!window.confirm("Leave this group?")) return;
        try {
            await leaveGroup(existingGroup!.id);
            onSuccess?.();
            onClose();
        } catch {
            /* surfaced upstream */
        }
    };

    const save = async () => {
        if (!name.trim() || selected.length < 1) return;
        setSaving(true);
        try {
            if (isEdit) {
                const existingIds = new Set((existingMembers || []).map((m) => m.id));
                const currentIds = new Set(selected.map((m) => m.id));
                const addUserIds = selected
                    .filter((m) => !existingIds.has(m.id))
                    .map((m) => m.id);
                const removeUserIds = (existingMembers || [])
                    .filter((m) => !currentIds.has(m.id))
                    .map((m) => m.id);
                await updateGroup(existingGroup!.id, {
                    name: name.trim(),
                    description: description.trim() || null,
                    addUserIds,
                    removeUserIds,
                });
            } else {
                await createGroup(name.trim(), selected.map((u) => u.id));
            }
            onSuccess?.();
            onClose();
        } catch {
            /* error handled upstream */
        }
        setSaving(false);
    };

    const roleBadge = (role?: GroupRole) => {
        if (role === "owner")
            return (
                <span className={s.roleBadge} title="Owner">
                    <Crown size={12} /> Owner
                </span>
            );
        if (role === "admin")
            return (
                <span className={s.roleBadge} title="Admin">
                    <Shield size={12} /> Admin
                </span>
            );
        return null;
    };

    return (
        <div
            className={s.overlay}
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            <div className={s.modal}>
                <div className={s.header}>
                    <h3>{isEdit ? "Group settings" : "New Group"}</h3>
                    <button className={s.closeBtn} onClick={onClose}>
                        <X size={16} />
                    </button>
                </div>
                <div className={s.body}>
                    <input
                        className={s.input}
                        placeholder="Group name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={100}
                        disabled={isEdit && !isAdminish}
                    />
                    <textarea
                        className={s.input}
                        placeholder="Group description (optional)"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        maxLength={500}
                        rows={2}
                        disabled={isEdit && !isAdminish}
                    />
                    {(!isEdit || isAdminish) && (
                        <input
                            className={s.input}
                            placeholder="Search users to add..."
                            value={search}
                            onChange={(e) => {
                                setSearch(e.target.value);
                                doSearch(e.target.value);
                            }}
                        />
                    )}
                    {searchResults.length > 0 && (
                        <div className={s.searchList}>
                            {searchResults.map((u) => (
                                <button
                                    key={u.id}
                                    className={s.searchItem}
                                    onClick={() => addUser(u)}
                                >
                                    <ChatAvatar
                                        avatar={u.avatar}
                                        name={u.full_name}
                                        size="sm"
                                    />
                                    <span>{u.full_name}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {selected.length > 0 && (
                        <div className={s.memberList}>
                            {selected.map((u) => {
                                const isSelf =
                                    currentUserId != null &&
                                    String(u.id) === String(currentUserId);
                                const canManage =
                                    isEdit && isAdminish && !isSelf && u.role !== "owner";
                                return (
                                    <div key={u.id} className={s.memberRow}>
                                        <ChatAvatar
                                            avatar={u.avatar}
                                            name={u.full_name}
                                            size="sm"
                                        />
                                        <span className={s.memberName}>
                                            {u.full_name}
                                            {isSelf ? " (You)" : ""}
                                        </span>
                                        {roleBadge(u.role)}
                                        {canManage && (
                                            <div className={s.memberMenuWrap}>
                                                <button
                                                    className={s.iconBtn}
                                                    onClick={() =>
                                                        setMenuFor(
                                                            menuFor === u.id ? null : u.id,
                                                        )
                                                    }
                                                    title="Manage member"
                                                >
                                                    <MoreVertical size={16} />
                                                </button>
                                                {menuFor === u.id && (
                                                    <div className={s.memberMenu}>
                                                        {u.role === "admin" ? (
                                                            <button
                                                                onClick={() =>
                                                                    changeRole(u.id, "member")
                                                                }
                                                            >
                                                                Remove admin
                                                            </button>
                                                        ) : (
                                                            <button
                                                                onClick={() =>
                                                                    changeRole(u.id, "admin")
                                                                }
                                                            >
                                                                Make admin
                                                            </button>
                                                        )}
                                                        {isOwner && (
                                                            <button
                                                                onClick={() => makeOwner(u.id)}
                                                            >
                                                                Make owner
                                                            </button>
                                                        )}
                                                        <button
                                                            className={s.danger}
                                                            onClick={() => {
                                                                removeUser(u.id);
                                                                setMenuFor(null);
                                                            }}
                                                        >
                                                            Remove from group
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {/* Non-admins (and self) just see a chip-style remove
                                            while creating a new group. */}
                                        {!isEdit && (
                                            <button
                                                className={s.iconBtn}
                                                onClick={() => removeUser(u.id)}
                                            >
                                                <X size={14} />
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
                <div className={s.footer}>
                    {isEdit && (
                        <button className={s.leaveBtn} onClick={doLeave}>
                            <LogOut size={14} /> Leave
                        </button>
                    )}
                    <button
                        className={s.saveBtn}
                        disabled={
                            !name.trim() ||
                            selected.length < 1 ||
                            saving ||
                            (isEdit && !isAdminish)
                        }
                        onClick={save}
                    >
                        {isEdit ? "Save" : "Create Group"}
                    </button>
                </div>
            </div>
        </div>
    );
}