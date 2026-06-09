import s from "../Dashboard.module.css";

export default function DashboardSkeleton() {
    return (
        <div className={s.dashboard}>
            <div className={s["skeleton-banner"]} />
            <div className={s["dashboard-row-1"]}>
                <div className={s["skeleton-timer-card"]}>
                    <div className={s["skeleton-circle"]} />
                    <div className={`${s["skeleton-line"]} ${s["skeleton-bar-60"]}`} />
                    <div className={`${s["skeleton-line"]} ${s["skeleton-bar-80"]}`} />
                    <div className={`${s["skeleton-line"]} ${s["skeleton-bar-40"]}`} />
                </div>
                <div className={s["skeleton-right"]}>
                    <div className={s["skeleton-card"]} />
                    <div className={s["skeleton-card"]} />
                </div>
            </div>
        </div>
    );
}