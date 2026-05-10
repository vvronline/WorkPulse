import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Settings as SettingsIcon, Palette, Plug, ShieldCheck } from 'lucide-react';
import { getCurrentOrg } from '../../api';
import OrgGeneralSettings from '../../components/organization/OrgSettings';
import OrgRegistrationSettings from './OrgSettings';
import s from './OrgSettingsPage.module.css';

/**
 * OrgSettingsPage — single scrollable page with anchor sections.
 *
 * Replaces the inner tab strip used in MyOrganization for org settings.
 * A sticky left rail of section anchors highlights the currently visible
 * section via IntersectionObserver. Clicking an anchor scrolls smoothly
 * to that section.
 *
 * Sections:
 *   - General      (timezone, work hours, fiscal year, presence rules)
 *   - Registration (mode + invite codes — gated to super_admin / platform_admin)
 *   - Branding     (placeholder)
 *   - Integrations (placeholder)
 */
export default function OrgSettingsPage({ userRole }) {
    const [org, setOrg] = useState(null);
    const [loading, setLoading] = useState(true);
    const isSuper = userRole === 'super_admin' || userRole === 'platform_admin';

    const sectionRefs = useRef({});
    const [activeSection, setActiveSection] = useState('general');

    const fetchOrg = useCallback(() => {
        setLoading(true);
        getCurrentOrg()
            .then(r => { setOrg(r.data); setLoading(false); })
            .catch(() => setLoading(false));
    }, []);

    useEffect(() => { fetchOrg(); }, [fetchOrg]);

    const sections = useMemo(() => ([
        { id: 'general',      label: 'General',      icon: SettingsIcon },
        ...(isSuper ? [{ id: 'registration', label: 'Registration', icon: ShieldCheck }] : []),
        { id: 'branding',     label: 'Branding',     icon: Palette },
        { id: 'integrations', label: 'Integrations', icon: Plug },
    ]), [isSuper]);

    useEffect(() => {
        if (loading) return;
        const obs = new IntersectionObserver(
            entries => {
                const visible = entries
                    .filter(e => e.isIntersecting)
                    .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
                if (visible[0]) setActiveSection(visible[0].target.dataset.sectionId);
            },
            { rootMargin: '-20% 0px -65% 0px', threshold: [0, 0.2, 0.5] },
        );
        Object.values(sectionRefs.current).forEach(el => el && obs.observe(el));
        return () => obs.disconnect();
    }, [sections.length, loading]);

    const scrollTo = (id) => {
        const el = sectionRefs.current[id];
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActiveSection(id);
    };

    if (loading) return <div className={s.empty}>Loading…</div>;
    if (!org) return <div className={s.empty}>You are not assigned to any organization yet.</div>;

    return (
        <div className={s.layout}>
            {/* Sticky anchor rail */}
            <nav className={s.rail} aria-label="Settings sections">
                {sections.map(sec => {
                    const Icon = sec.icon;
                    const active = activeSection === sec.id;
                    return (
                        <button
                            key={sec.id}
                            type="button"
                            className={`${s.railItem} ${active ? s.railActive : ''}`}
                            onClick={() => scrollTo(sec.id)}
                        >
                            <Icon size={14} className={s.railIcon} />
                            <span>{sec.label}</span>
                        </button>
                    );
                })}
            </nav>

            <div className={s.body}>
                <section
                    id="general"
                    data-section-id="general"
                    ref={el => (sectionRefs.current.general = el)}
                    className={s.section}
                >
                    <header className={s.sectionHead}>
                        <SettingsIcon size={18} className={s.sectionIcon} />
                        <div>
                            <h2 className={s.sectionTitle}>General</h2>
                            <p className={s.sectionDesc}>
                                Organization name, timezone, working hours, fiscal year, and presence rules.
                            </p>
                        </div>
                    </header>
                    <div className={s.sectionBody}>
                        <OrgGeneralSettings org={org} onUpdate={fetchOrg} userRole={userRole} />
                    </div>
                </section>

                {isSuper && (
                    <section
                        id="registration"
                        data-section-id="registration"
                        ref={el => (sectionRefs.current.registration = el)}
                        className={s.section}
                    >
                        <header className={s.sectionHead}>
                            <ShieldCheck size={18} className={s.sectionIcon} />
                            <div>
                                <h2 className={s.sectionTitle}>Registration</h2>
                                <p className={s.sectionDesc}>
                                    Control how new users join — open registration, invite-only, or closed.
                                    Generate and manage invite codes.
                                </p>
                            </div>
                        </header>
                        <div className={s.sectionBody}>
                            <OrgRegistrationSettings />
                        </div>
                    </section>
                )}

                <section
                    id="branding"
                    data-section-id="branding"
                    ref={el => (sectionRefs.current.branding = el)}
                    className={s.section}
                >
                    <header className={s.sectionHead}>
                        <Palette size={18} className={s.sectionIcon} />
                        <div>
                            <h2 className={s.sectionTitle}>Branding</h2>
                            <p className={s.sectionDesc}>
                                Logo, color scheme, and email-template branding for your organization.
                            </p>
                        </div>
                    </header>
                    <div className={s.sectionBody}>
                        <div className={s.placeholder}>
                            Branding customization isn't available yet. It's on the roadmap and will let you
                            upload a logo and choose an accent color that applies to the app and outgoing emails.
                        </div>
                    </div>
                </section>

                <section
                    id="integrations"
                    data-section-id="integrations"
                    ref={el => (sectionRefs.current.integrations = el)}
                    className={s.section}
                >
                    <header className={s.sectionHead}>
                        <Plug size={18} className={s.sectionIcon} />
                        <div>
                            <h2 className={s.sectionTitle}>Integrations</h2>
                            <p className={s.sectionDesc}>
                                Connect WorkPulse with calendar providers, Slack, payroll systems, and SSO.
                            </p>
                        </div>
                    </header>
                    <div className={s.sectionBody}>
                        <div className={s.placeholder}>
                            Integrations are coming soon. Planned: Google / Microsoft calendar sync, Slack
                            notifications, SAML SSO, and payroll exports.
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}