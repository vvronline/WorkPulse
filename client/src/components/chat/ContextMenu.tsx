import s from "./ContextMenu.module.css";
import React, { useEffect, useRef } from "react";

export interface ContextMenuItem {
    label: React.ReactNode;
    icon?: React.ReactNode;
    danger?: boolean;
    onClick: () => void;
}

interface ContextMenuProps {
    x: number;
    y: number;
    items: (ContextMenuItem | false | null | undefined)[];
    onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
    const ref = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const handler = (e: PointerEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener("pointerdown", handler);
        return () => document.removeEventListener("pointerdown", handler);
    }, [onClose]);

    // Adjust position to stay within viewport
    useEffect(() => {
        if (!ref.current) return;
        const rect = ref.current.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            ref.current.style.left = `${x - rect.width}px`;
        }
        if (rect.left < 0) {
            ref.current.style.left = `4px`;
        }
        if (rect.bottom > window.innerHeight) {
            ref.current.style.top = `${y - rect.height}px`;
        }
        if (rect.top < 0) {
            ref.current.style.top = `4px`;
        }
    }, [x, y]);

    return (
        <div ref={ref} className={s.menu} style={{ left: x, top: y }}>
            {items.filter((it): it is ContextMenuItem => Boolean(it)).map((item, i) => (
                <button
                    key={i}
                    className={`${s.item} ${item.danger ? s.danger : ""}`}
                    onClick={() => { item.onClick(); onClose(); }}
                >
                    <span className={s.icon}>{item.icon}</span>
                    {item.label}
                </button>
            ))}
        </div>
    );
}