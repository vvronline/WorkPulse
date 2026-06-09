/* TagDots — compact coloured dot row shown on page list items */
import React from "react";
import { tagColor } from "../notesUtils";
import s from "./TagDots.module.css";

interface TagDotsProps {
    tags?: string[];
}

export default function TagDots({ tags = [] }: TagDotsProps) {
    if (!tags.length) return null;
    return (
        <span className={s.tagDots}>
            {tags.slice(0, 4).map(t => (
                <span key={t} className={s.tagDot} style={{ background: tagColor(t) }} title={t} />
            ))}
        </span>
    );
}