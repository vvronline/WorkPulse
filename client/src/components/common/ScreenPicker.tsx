import { useState, useEffect } from "react";
import s from "./ScreenPicker.module.css";

interface ScreenSource {
    id: string;
    name: string;
    thumbnail: string;
    appIcon?: string;
}

const api = window.electronAPI as unknown as {
    onScreenSources?: (cb: (list: ScreenSource[]) => void) => (() => void) | void;
    selectScreenSource: (id: string | null) => void;
} | undefined;

/**
 * Electron screen/window picker overlay.
 * Shown when getDisplayMedia triggers the main process to send available sources.
 */
export default function ScreenPicker() {
    const [sources, setSources] = useState<ScreenSource[] | null>(null);

    useEffect(() => {
        if (!api?.onScreenSources) return;
        const unsub = api.onScreenSources((list) => setSources(list));
        return () => {
            if (typeof unsub === "function") unsub();
        };
    }, []);

    if (!sources) return null;

    const screens = sources.filter((src) => src.id.startsWith("screen:"));
    const windows = sources.filter((src) => src.id.startsWith("window:"));

    const select = (id: string) => {
        api!.selectScreenSource(id);
        setSources(null);
    };

    const cancel = () => {
        api!.selectScreenSource(null);
        setSources(null);
    };

    return (
        <div className={s.overlay} onClick={cancel}>
            <div className={s.modal} onClick={(e) => e.stopPropagation()}>
                <div className={s.header}>
                    <h3 className={s.title}>Share your screen</h3>
                    <button className={s.closeBtn} onClick={cancel}>&times;</button>
                </div>

                {screens.length > 0 && (
                    <div className={s.section}>
                        <h4 className={s.sectionTitle}>Screens</h4>
                        <div className={s.grid}>
                            {screens.map((src) => (
                                <button key={src.id} className={s.sourceBtn} onClick={() => select(src.id)}>
                                    <img src={src.thumbnail} alt={src.name} className={s.thumbnail} />
                                    <span className={s.sourceName}>{src.name}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {windows.length > 0 && (
                    <div className={s.section}>
                        <h4 className={s.sectionTitle}>Windows</h4>
                        <div className={s.grid}>
                            {windows.map((src) => (
                                <button key={src.id} className={s.sourceBtn} onClick={() => select(src.id)}>
                                    <img src={src.thumbnail} alt={src.name} className={s.thumbnail} />
                                    <span className={s.sourceName}>
                                        {src.appIcon && <img src={src.appIcon} alt="" className={s.appIcon} />}
                                        {src.name}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div className={s.footer}>
                    <button className={s.cancelBtn} onClick={cancel}>Cancel</button>
                </div>
            </div>
        </div>
    );
}