import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Settings as SettingsIcon,
  Palette,
  UserCog,
  Mail,
  MapPin,
} from "lucide-react";
import { getCurrentOrg } from "../../api";
import OrgGeneralSettings from "../../components/organization/OrgSettings";
import OfficeLocationSettings from "../../components/organization/OfficeLocationSettings";
import OrgRoleLabels from "./OrgRoleLabels";
import BrandingSection from "./BrandingSection";
import EmailTemplatesSection from "./EmailTemplatesSection";
import s from "./OrgSettingsPage.module.css";
import type { LucideIcon } from "lucide-react";

interface SectionDef {
  id: string;
  label: string;
  icon: LucideIcon;
}

interface OrgSettingsPageProps {
  userRole?: string;
}

/**
 * OrgSettingsPage — single scrollable page with anchor sections.
 *
 * Replaces the inner tab strip used in MyOrganization for org settings.
 * A sticky left rail of section anchors highlights the currently visible
 * section via IntersectionObserver. Clicking an anchor scrolls smoothly
 * to that section.
 *
 * Sections:
 *   - General        (timezone, work hours, fiscal year, presence rules)
 *   - Attendance     (office location + face/geofence verification)
 *   - Roles          (role labels and permission levels)
 *   - Branding       (logo + accent colour)
 *   - Email templates (per-event subject/body customisation)
 *
 * Note: Integrations (GitHub etc.) live under Admin → Integrations as a
 * dedicated catalog page; they are intentionally not surfaced here to
 * avoid two parallel "Integrations" surfaces.
 */
export default function OrgSettingsPage({ userRole }: OrgSettingsPageProps) {
  const queryClient = useQueryClient();
  const { data: org = null, isLoading: loading } = useQuery({
    queryKey: ["admin", "org-settings"],
    queryFn: async () => (await getCurrentOrg()).data,
  });
  const isSuper = userRole === "super_admin" || userRole === "platform_admin";
  // Branding + email templates: hr_admin, super_admin, and platform_admin
  // can edit. Everyone else sees the section read-only (the BrandingContext
  // still applies the values app-wide).
  const canEditBranding = isSuper || userRole === "hr_admin";

  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [activeSection, setActiveSection] = useState("general");

  // Children call this after a successful save — background refetch, no
  // spinner. invalidateQueries refetches without flipping isLoading (cold
  // cache only), so the section tree never unmounts and child components
  // keep their local state while the fetch is in flight.
  const silentRefetch = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["admin", "org-settings"] });
  }, [queryClient]);

  // Attendance verification (face + location) is gated to admins who can
  // already edit org settings — that's hr_admin / super_admin / platform_admin
  // server-side. We surface it as its own scroll-anchored section so it's
  // discoverable as a first-class feature, not buried in the General form.
  const canEditAttendance = isSuper || userRole === "hr_admin";

  const sections = useMemo<SectionDef[]>(
    () => [
      { id: "general", label: "General", icon: SettingsIcon },
      ...(canEditAttendance
        ? [{ id: "attendance", label: "Attendance Verification", icon: MapPin }]
        : []),
      { id: "roles", label: "Roles", icon: UserCog },
      { id: "branding", label: "Branding", icon: Palette },
      { id: "email-templates", label: "Email templates", icon: Mail },
    ],
    [isSuper, canEditAttendance],
  );

  useEffect(() => {
    if (loading) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) =>
              Math.abs(a.boundingClientRect.top) -
              Math.abs(b.boundingClientRect.top),
          );
        if (visible[0])
          setActiveSection(
            (visible[0].target as HTMLElement).dataset.sectionId || "general",
          );
      },
      { rootMargin: "-20% 0px -65% 0px", threshold: [0, 0.2, 0.5] },
    );
    Object.values(sectionRefs.current).forEach((el) => el && obs.observe(el));
    return () => obs.disconnect();
  }, [sections.length, loading]);

  const scrollTo = (id: string) => {
    const el = sectionRefs.current[id];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(id);
  };

  if (loading) return <div className={s.empty}>Loading…</div>;
  if (!org)
    return (
      <div className={s.empty}>
        You are not assigned to any organization yet.
      </div>
    );

  return (
    <div className={s.layout}>
      {/* Sticky anchor rail */}
      <nav className={s.rail} aria-label="Settings sections">
        {sections.map((sec) => {
          const Icon = sec.icon;
          const active = activeSection === sec.id;
          return (
            <button
              key={sec.id}
              type="button"
              className={`${s.railItem} ${active ? s.railActive : ""}`}
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
          ref={(el) => {
            sectionRefs.current.general = el;
          }}
          className={s.section}
        >
          <header className={s.sectionHead}>
            <SettingsIcon size={18} className={s.sectionIcon} />
            <div>
              <h2 className={s.sectionTitle}>General</h2>
              <p className={s.sectionDesc}>
                Organization name, timezone, working hours, fiscal year, and
                presence rules.
              </p>
            </div>
          </header>
          <div className={s.sectionBody}>
            <OrgGeneralSettings
              org={org}
              onUpdate={silentRefetch}
              userRole={userRole}
            />
          </div>
        </section>

        {canEditAttendance && (
          <section
            id="attendance"
            data-section-id="attendance"
            ref={(el) => {
              sectionRefs.current.attendance = el;
            }}
            className={s.section}
          >
            <header className={s.sectionHead}>
              <MapPin size={18} className={s.sectionIcon} />
              <div>
                <h2 className={s.sectionTitle}>Attendance Verification</h2>
                <p className={s.sectionDesc}>
                  Pin the office on the map, set a geofence radius, and toggle
                  face + location checks for clock-in. When enabled, employees
                  must be within the geofence for office mode and pass a face
                  match for both office and remote modes.
                </p>
              </div>
            </header>
            <div className={s.sectionBody}>
              <OfficeLocationSettings org={org} onUpdate={silentRefetch} />
            </div>
          </section>
        )}

        <section
          id="roles"
          data-section-id="roles"
          ref={(el) => {
            sectionRefs.current.roles = el;
          }}
          className={s.section}
        >
          <header className={s.sectionHead}>
            <UserCog size={18} className={s.sectionIcon} />
            <div>
              <h2 className={s.sectionTitle}>Roles</h2>
              <p className={s.sectionDesc}>
                Define your organisation's roles. Each role is pinned to one of
                four permission levels (Standard&nbsp;member, Team&nbsp;lead,
                Manager, HR&nbsp;admin) which controls what they can see and do.
                Add, rename, recolour, or remove unused roles freely.
              </p>
            </div>
          </header>
          <div className={s.sectionBody}>
            <OrgRoleLabels canEdit={isSuper} />
          </div>
        </section>

        <section
          id="branding"
          data-section-id="branding"
          ref={(el) => {
            sectionRefs.current.branding = el;
          }}
          className={s.section}
        >
          <header className={s.sectionHead}>
            <Palette size={18} className={s.sectionIcon} />
            <div>
              <h2 className={s.sectionTitle}>Branding</h2>
              <p className={s.sectionDesc}>
                Upload a logo and pick an accent color. The accent is applied
                across the app (buttons, links, badges) and the header bar of
                every outgoing email.
              </p>
            </div>
          </header>
          <div className={s.sectionBody}>
            <BrandingSection canEdit={canEditBranding} />
          </div>
        </section>

        <section
          id="email-templates"
          data-section-id="email-templates"
          ref={(el) => {
            sectionRefs.current["email-templates"] = el;
          }}
          className={s.section}
        >
          <header className={s.sectionHead}>
            <Mail size={18} className={s.sectionIcon} />
            <div>
              <h2 className={s.sectionTitle}>Email templates</h2>
              <p className={s.sectionDesc}>
                Customise the subject and body of every notification email
                (leaves, tasks, mentions, meetings, manual entries). Tweak the
                wording or disable individual templates without touching the
                code.
              </p>
            </div>
          </header>
          <div className={s.sectionBody}>
            <EmailTemplatesSection canEdit={canEditBranding} />
          </div>
        </section>
      </div>
    </div>
  );
}
