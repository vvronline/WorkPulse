import { useState, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../../AuthContext';
import { useChatUnread } from '../../ChatContext';
import { useClickOutside } from '../../hooks/useClickOutside';
import { Home, Calendar, ClipboardList, MessageSquare, FileEdit, Palmtree, BarChart3, FileText, Building2, Users, Settings } from 'lucide-react';
import s from './Navbar.module.css';

const ROLE_LEVELS = { employee: 1, team_lead: 2, manager: 3, hr_admin: 4, super_admin: 5, platform_admin: 6 };

export default function MobileTabBar() {
    const { user } = useAuth();
    const location = useLocation();
    const { unreadCount: chatUnread } = useChatUnread();
    const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
    const mobileMoreRef = useRef(null);

    useClickOutside(mobileMoreRef, () => setMobileMoreOpen(false));

    const userLevel = ROLE_LEVELS[user?.role] || 1;
    const isTeamLead = userLevel >= 2 || user?.has_reports;
    const isHR = userLevel >= 4;

    // Secondary items shown in More sheet
    const moreItems = [
        { to: '/notes', label: 'Notes', icon: FileText },
        { to: '/leaves', label: 'Leaves', icon: Palmtree },
        { to: '/analytics', label: 'Analytics', icon: BarChart3 },
        { to: '/manual-entry', label: 'Manual Entry', icon: FileEdit },
    ];
    if (user?.org_id) moreItems.push({ to: '/organization', label: 'Organization', icon: Building2 });
    if (user?.org_id) moreItems.push({ to: '/leave-policy', label: 'Leave Policy', icon: ClipboardList });
    if (isTeamLead) moreItems.push({ to: '/manager', label: 'My Team', icon: Users });
    if (isHR) moreItems.push({ to: '/admin', label: 'Admin', icon: Settings });

    const moreIsActive = moreItems.some(item => location.pathname === item.to);
    const p = location.pathname;

    return (
        <div className={s['mobile-tab-bar']}>
            <NavLink to="/" className={p === '/' ? s.active : ''}>
                <span className={s['nav-icon']}><Home size={22} /></span>
                <span className={s['tab-label']}>Home</span>
            </NavLink>
            <NavLink to="/calendar" className={p === '/calendar' ? s.active : ''}>
                <span className={s['nav-icon']}><Calendar size={22} /></span>
                <span className={s['tab-label']}>Calendar</span>
            </NavLink>
            <NavLink to="/tasks" className={p === '/tasks' ? s.active : ''}>
                <span className={s['nav-icon']}><ClipboardList size={22} /></span>
                <span className={s['tab-label']}>Tasks</span>
            </NavLink>
            <NavLink to="/chat" className={`${p === '/chat' ? s.active : ''} ${s.chatLink}`}>
                <span className={s['nav-icon']}><MessageSquare size={22} /></span>
                <span className={s['tab-label']}>Chat</span>
                {chatUnread > 0 && <span className={s.chatBadge}>{chatUnread > 99 ? '99+' : chatUnread}</span>}
            </NavLink>
            <div className={s['mobile-more-wrapper']} ref={mobileMoreRef}>
                <button
                    className={`${s['mobile-more-btn']} ${mobileMoreOpen || moreIsActive ? s.active : ''}`}
                    onClick={() => setMobileMoreOpen(prev => !prev)}
                >
                    <span className={s['nav-icon']}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                            <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                    </span>
                    <span className={s['tab-label']}>More</span>
                </button>
                {mobileMoreOpen && (
                    <div className={s['mobile-more-popup']}>
                        {moreItems.map(item => (
                            <NavLink key={item.to} to={item.to}
                                className={p === item.to ? s.active : ''}
                                onClick={() => setMobileMoreOpen(false)}
                            >
                                {item.icon && <item.icon size={18} />} {item.label}
                            </NavLink>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
