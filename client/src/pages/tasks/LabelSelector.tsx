import React, { useRef, useEffect } from "react";
import s from "./LabelSelector.module.css";
import type { TaskLabel } from "../../types";

interface LabelSelectorProps {
    labels: TaskLabel[];
    selected: Array<number | string>;
    onToggle: (id: number | string) => void;
    open: boolean;
    setOpen: (value: boolean | ((o: boolean) => boolean)) => void;
}

export default function LabelSelector({
    labels,
    selected,
    onToggle,
    open,
    setOpen,
}: LabelSelectorProps) {
    const ref = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [setOpen]);

    return (
        <div className={s["label-selector"]} ref={ref}>
            <button
                type="button"
                className={s["label-selector-btn"]}
                onClick={() => setOpen((o) => !o)}
            >
                🏷️ Labels{" "}
                {selected.length > 0 && (
                    <span className={s["label-count"]}>{selected.length}</span>
                )}
            </button>
            {open && (
                <div className={s["label-dropdown"]}>
                    {labels.length === 0 && (
                        <div className={s["label-dropdown-empty"]}>No labels configured</div>
                    )}
                    {labels.map((l) => (
                        <label key={l.id} className={s["label-option"]}>
                            <input
                                type="checkbox"
                                checked={selected.includes(l.id)}
                                onChange={() => onToggle(l.id)}
                            />
                            <span
                                className={s["label-pill"]}
                                style={{ "--label-color": l.color } as React.CSSProperties}
                            >
                                {l.name}
                            </span>
                        </label>
                    ))}
                </div>
            )}
        </div>
    );
}