import React from "react";
import { RotateCcw, FileEdit, Clock } from "lucide-react";
import { LEAVE_ICONS } from "./constants";

interface LeaveIconForProps {
    type?: string;
}

function LeaveIconFor({ type }: LeaveIconForProps) {
    const Ic = type ? LEAVE_ICONS[type] : undefined;
    return Ic ? <Ic size={13} /> : null;
}

interface RequestDetailsProps {
    request: {
        type?: string;
        metadata?: Record<string, any> | null;
        [key: string]: any;
    };
}

export default function RequestDetails({ request }: RequestDetailsProps) {
    const meta = request.metadata;
    if (!meta) return <span>—</span>;

    if (request.type === "leave") {
        return (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <LeaveIconFor type={meta.leave_type} /> {meta.leave_type} • {meta.date}{" "}
                {meta.duration && meta.duration !== "full" ? `(${meta.duration})` : ""}
            </span>
        );
    }
    if (request.type === "leave_withdraw") {
        return (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <RotateCcw size={13} /> Withdraw <LeaveIconFor type={meta.leave_type} />{" "}
                {meta.leave_type} • {meta.date}{" "}
                {meta.previous_status ? `(was ${meta.previous_status})` : ""}
            </span>
        );
    }
    if (request.type === "manual_entry") {
        return (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <FileEdit size={13} /> {meta.date} • {meta.clock_in}
                {meta.clock_out ? ` → ${meta.clock_out}` : ""}{" "}
                {meta.work_mode ? `(${meta.work_mode})` : ""}
            </span>
        );
    }
    if (request.type === "overtime") {
        return (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <Clock size={13} /> {meta.date} • {meta.hours}h
            </span>
        );
    }
    return <span>{JSON.stringify(meta)}</span>;
}