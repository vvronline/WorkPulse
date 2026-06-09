import { useState, useEffect } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../../AuthContext";
import { useBranding } from "../../BrandingContext";
import { serverURL } from "../../api";
import NavLinks from "./NavLinks";
import ProfileMenu from "./ProfileMenu";
import MobileTabBar from "./MobileTabBar";
import NotificationBell from "../notifications/NotificationBell";
import GlobalSearch from "../search/GlobalSearch";
import WindowControls from "./WindowControls";
import s from "./Navbar.module.css";

const isElectron = !!window.electronAPI?.isElectron;
const isMacElectron = isElectron && window.electronAPI?.platform === "darwin";

export default function Navbar() {
    const { isAuthenticated } = useAuth() as any;
    const { branding } = useBranding() as any;
    const [searchOpen, setSearchOpen] = useState(false);
    const logoSrc = branding?.logo_url
        ? branding.logo_url.startsWith("http")
            ? branding.logo_url
            : `${serverURL}${branding.logo_url}`
        : null;

    // Ctrl+K / Cmd+K opens global search from anywhere
    useEffect(() => {
        const handle = (e: KeyboardEvent) => {
            if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                setSearchOpen((prev) => !prev);
            }
        };
        document.addEventListener("keydown", handle);
        return () => document.removeEventListener("keydown", handle);
    }, []);

    if (!isAuthenticated) return null;

    return (
        <>
            <nav className={`${s.navbar} ${isElectron ? s.electronNavbar : ""}`}>
                <NavLink to="/" className={s["navbar-logo"]}>
                    {logoSrc ? (
                        <img src={logoSrc} alt="Logo" className={s["logo-img"]} />
                    ) : (
                        <div className={s["logo-icon"]}>💼</div>
                    )}
                    <h1 className={s.title}>{branding?.org_name || "WorkPulse"}</h1>
                </NavLink>
                <div className={s["navbar-right"]}>
                    <NavLinks />
                    <NotificationBell />
                    <button
                        className={s.searchBtn}
                        onClick={() => setSearchOpen(true)}
                        title="Search (Ctrl+K)"
                        aria-label="Open global search"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                            <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2" />
                            <path
                                d="M21 21l-4.35-4.35"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                            />
                        </svg>
                    </button>
                    <ProfileMenu />
                    {isElectron && !isMacElectron && <WindowControls />}
                </div>
            </nav>

            <MobileTabBar />

            {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}
        </>
    );
}