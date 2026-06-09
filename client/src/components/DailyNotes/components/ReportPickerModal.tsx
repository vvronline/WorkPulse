/* eslint-disable @typescript-eslint/no-explicit-any */
/* ReportPickerModal — modal for picking a direct report when creating
   a prefilled 1-on-1 page via the /oneonone slash command. */
import React, { useState, useEffect } from "react";
import { getDirectReports } from "../../../api";
import { Users, Search, X } from "lucide-react";
import s from "./ReportPickerModal.module.css";

interface ReportPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (id: any) => void;
}

export default function ReportPickerModal({ isOpen, onClose, onSelect }: ReportPickerModalProps) {
    const [reports, setReports] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [filter, setFilter] = useState("");

    useEffect(() => {
        if (!isOpen) return;
        setLoading(true);
        getDirectReports()
            .then(res => setReports((res.data as any)?.reports || []))
            .catch(() => setReports([]))
            .finally(() => setLoading(false));
    }, [isOpen]);

    if (!isOpen) return null;

    const filtered = filter
        ? reports.filter(r =>
            (r.full_name || "").toLowerCase().includes(filter.toLowerCase()) ||
            (r.username || "").toLowerCase().includes(filter.toLowerCase())
        )
        : reports;

    return (
        <div className={s.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className={s.modal}>
                <div className={s.header}>
                    <Users size={16} />
                    <span>Select a direct report for 1-on-1</span>
                    <button className={s.closeBtn} onClick={onClose}><X size={14} /></button>
                </div>

                <div className={s.searchWrap}>
                    <Search size={13} />
                    <input
                        className={s.searchInput}
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        placeholder="Search reports…"
                        autoFocus
                    />
                </div>

                <div className={s.list}>
                    {loading && <div className={s.empty}>Loading…</div>}
                    {!loading && filtered.length === 0 && (
                        <div className={s.empty}>
                            {reports.length === 0 ? "No direct reports found" : "No matches"}
                        </div>
                    )}
                    {filtered.map(r => (
                        <button key={r.id} className={s.item} onClick={() => { onSelect(r.id); onClose(); }}>
                            {r.avatar ? (
                                <img src={r.avatar} className={s.avatar} alt="" />
                            ) : (
                                <div className={s.avatarPlaceholder}>{(r.full_name || "?")[0]}</div>
                            )}
                            <div className={s.info}>
                                <div className={s.name}>{r.full_name}</div>
                                <div className={s.username}>@{r.username}</div>
                            </div>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}