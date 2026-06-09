/* eslint-disable @typescript-eslint/no-explicit-any */
/* PresenceAvatars — shows coloured avatars of users currently viewing/editing the page.
   Rendered in the editor top bar area. */
import React from "react";
import s from "./PresenceAvatars.module.css";

interface PresenceUser {
    clientId: string | number;
    name?: string;
    color?: string;
    avatar?: string;
    [key: string]: unknown;
}

interface PresenceAvatarsProps {
    users: PresenceUser[];
    connected?: boolean;
}

export default function PresenceAvatars({ users, connected }: PresenceAvatarsProps) {
    if (!connected || users.length === 0) return null;

    return (
        <div className={s.root} title={`${users.length} other${users.length > 1 ? "s" : ""} viewing`}>
            {users.slice(0, 5).map((u) => (
                <div
                    key={u.clientId}
                    className={s.avatar}
                    style={{ borderColor: u.color }}
                    title={`${u.name} is viewing`}
                >
                    {u.avatar ? (
                        <img src={u.avatar} alt={u.name} className={s.img} />
                    ) : (
                        <span className={s.initials} style={{ backgroundColor: u.color }}>
                            {u.name?.charAt(0)?.toUpperCase() || "?"}
                        </span>
                    )}
                </div>
            ))}
            {users.length > 5 && (
                <div className={s.overflow}>+{users.length - 5}</div>
            )}
            <span className={s.label}>
                {users.length === 1 ? `${users[0].name} is editing` : `${users.length} others editing`}
            </span>
        </div>
    );
}