/* ─────────────────────────────────────────────────────────
   Notes templates — used by the Home screen quick-action tiles
   and the empty-state template picker. Each template renders
   directly into Quill's HTML-compatible content.
   ───────────────────────────────────────────────────────── */

import {
  FilePlus,
  BookMarked,
  Handshake,
  ClipboardCheck,
  CalendarRange,
  Users,
  Repeat,
} from '../../constants/icons';

const todayLabel = () =>
  new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

const todayShort = () =>
  new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const todayISO = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

// ── Auto-prefill helpers for Tier 6 integrations ─────────

/**
 * Build HTML for the daily journal template using prefill data from the server.
 * @param {Object} prefill - { tasks, hoursWorked, meetings, events }
 */
export function buildJournalPrefillHtml(prefill) {
  const parts = [];
  parts.push(`<h2>${todayLabel()}</h2>`);

  // Time tracking summary
  if (prefill.hoursWorked != null) {
    parts.push(`<div class="ql-callout" data-callout="info"><p>⏱ <strong>${prefill.hoursWorked}h</strong> tracked today</p></div>`);
  }

  parts.push(`<h3>How I'm feeling</h3><p><br></p>`);

  // Tasks
  parts.push(`<h3>What I worked on</h3>`);
  if (prefill.tasks?.length > 0) {
    const done = prefill.tasks.filter(t => t.status === 'done');
    const other = prefill.tasks.filter(t => t.status !== 'done');
    // Quill check-list format requires the <li data-list="…"> nodes to live
    // inside a <ul>; otherwise they render as plain bullets without checkboxes.
    if (done.length > 0 || other.length > 0) {
      parts.push(`<ul>`);
      done.forEach(t => { parts.push(`<li data-list="checked">${escHtml(t.title)}</li>`); });
      other.forEach(t => { parts.push(`<li data-list="unchecked">${escHtml(t.title)} <em>(${escHtml(t.status)})</em></li>`); });
      parts.push(`</ul>`);
    }
  } else {
    parts.push(`<ul><li><br></li></ul>`);
  }

  // Meetings attended
  if (prefill.meetings?.length > 0) {
    parts.push(`<h3>Meetings</h3>`);
    prefill.meetings.forEach(m => {
      const time = new Date(m.scheduled_start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      parts.push(`<ul><li>📅 <strong>${escHtml(m.title)}</strong> at ${time}</li></ul>`);
    });
  }

  // Calendar events
  if (prefill.events?.length > 0 && (!prefill.meetings || prefill.meetings.length === 0)) {
    parts.push(`<h3>Events</h3>`);
    prefill.events.forEach(ev => {
      const time = ev.all_day ? 'All day' : new Date(ev.start_time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      parts.push(`<ul><li>${escHtml(ev.title)} — ${time}</li></ul>`);
    });
  }

  parts.push(`<h3>Wins</h3><ul><li><br></li></ul>`);
  parts.push(`<h3>Tomorrow</h3><ul><li data-list="unchecked"><br></li></ul>`);

  return parts.join('\n');
}

/**
 * Build HTML for the 1-on-1 template using prefill data from the server.
 * @param {Object} prefill - { report, tasks, leaves, sprint, hoursThisWeek }
 */
export function buildOneOnOnePrefillHtml(prefill) {
  const parts = [];
  const reportName = prefill.report?.fullName || 'Team member';
  parts.push(`<h2>1-on-1 — ${todayShort()}</h2>`);
  parts.push(`<p><strong>With:</strong> ${escHtml(reportName)}</p>`);

  // Hours this week
  if (prefill.hoursThisWeek != null) {
    parts.push(`<div class="ql-callout" data-callout="info"><p>📊 ${escHtml(reportName)} logged <strong>${prefill.hoursThisWeek}h</strong> this week</p></div>`);
  }

  // Recent task activity
  parts.push(`<h3>Recent task activity</h3>`);
  if (prefill.tasks?.length > 0) {
    const done = prefill.tasks.filter(t => t.status === 'done');
    const inProgress = prefill.tasks.filter(t => t.status === 'in_progress');
    const pending = prefill.tasks.filter(t => t.status === 'pending');
    if (done.length > 0) {
      parts.push(`<p><strong>Completed (${done.length}):</strong></p>`);
      // Wrap checked-list items in a <ul> so Quill renders proper checkboxes.
      parts.push(`<ul>`);
      done.slice(0, 8).forEach(t => { parts.push(`<li data-list="checked">${escHtml(t.title)}</li>`); });
      parts.push(`</ul>`);
    }
    if (inProgress.length > 0) {
      parts.push(`<p><strong>In progress (${inProgress.length}):</strong></p>`);
      // Group consecutive items in a single <ul> rather than one <ul> per item.
      parts.push(`<ul>`);
      inProgress.slice(0, 5).forEach(t => { parts.push(`<li>🔵 ${escHtml(t.title)}</li>`); });
      parts.push(`</ul>`);
    }
    if (pending.length > 0) {
      parts.push(`<p><strong>Pending (${pending.length}):</strong></p>`);
      parts.push(`<ul>`);
      pending.slice(0, 5).forEach(t => { parts.push(`<li>⬜ ${escHtml(t.title)}</li>`); });
      parts.push(`</ul>`);
    }
  } else {
    parts.push(`<p><em>No recent tasks</em></p>`);
  }

  // Sprint progress
  if (prefill.sprint) {
    const sp = prefill.sprint;
    parts.push(`<h3>Sprint: ${escHtml(sp.name)}</h3>`);
    if (sp.taskBreakdown?.length > 0) {
      const bd = {};
      sp.taskBreakdown.forEach(r => { bd[r.status] = r.count; });
      const total = Object.values(bd).reduce((a, b) => a + b, 0);
      const done = bd.done || 0;
      parts.push(`<p>Progress: <strong>${done}/${total}</strong> tasks done (${total > 0 ? Math.round((done / total) * 100) : 0}%)</p>`);
      if (bd.in_progress) parts.push(`<p>🔵 ${bd.in_progress} in progress</p>`);
      if (bd.pending) parts.push(`<p>⬜ ${bd.pending} pending</p>`);
    }
  }

  // Recent leaves
  if (prefill.leaves?.length > 0) {
    parts.push(`<h3>Recent leaves</h3>`);
    prefill.leaves.forEach(l => {
      parts.push(`<ul><li>${escHtml(l.date)} — ${escHtml(l.leave_type)} (${l.duration}, ${l.status})</li></ul>`);
    });
  }

  parts.push(`<h3>Wins / highlights</h3><ul><li><br></li></ul>`);
  parts.push(`<h3>Blockers</h3><ul><li><br></li></ul>`);
  parts.push(`<h3>Feedback</h3><p><br></p>`);
  parts.push(`<h3>Career / growth</h3><p><br></p>`);
  parts.push(`<h3>Action items</h3><ul><li data-list="unchecked"><br></li></ul>`);

  return parts.join('\n');
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const TEMPLATES = [
  {
    id: 'blank',
    name: 'Blank page',
    icon: FilePlus,
    description: 'Start from scratch.',
    title: () => 'Untitled',
    html: () => '',
  },
  {
    id: 'journal',
    name: "Today's journal",
    icon: BookMarked,
    description: 'A daily journal entry for today.',
    title: () => `Journal — ${todayISO()}`,
    folderName: 'Journal',
    html: () => `
      <h2>${todayLabel()}</h2>
      <h3>How I'm feeling</h3>
      <p><br></p>
      <h3>What I worked on</h3>
      <ul><li><br></li></ul>
      <h3>Wins</h3>
      <ul><li><br></li></ul>
      <h3>Tomorrow</h3>
      <ul><li data-list="unchecked"><br></li></ul>
    `,
  },
  {
    id: 'meeting',
    name: 'Meeting notes',
    icon: Handshake,
    description: 'Agenda, discussion, action items.',
    title: () => `Meeting notes — ${todayShort()}`,
    html: () => `
      <h2>Meeting notes — ${todayShort()}</h2>
      <p><strong>Attendees:</strong> </p>
      <p><strong>Date / time:</strong> ${todayLabel()}</p>
      <h3>Agenda</h3>
      <ul><li><br></li></ul>
      <h3>Discussion</h3>
      <p><br></p>
      <h3>Decisions</h3>
      <ul><li><br></li></ul>
      <h3>Action items</h3>
      <ul><li data-list="unchecked"><br></li></ul>
    `,
  },
  {
    id: 'decision',
    name: 'Decision log',
    icon: ClipboardCheck,
    description: 'Capture a decision and its rationale.',
    title: () => `Decision — ${todayShort()}`,
    html: () => `
      <h2>Decision — ${todayShort()}</h2>
      <p><strong>Status:</strong> Proposed</p>
      <p><strong>Owner:</strong> </p>
      <p><strong>Stakeholders:</strong> </p>
      <h3>Context</h3>
      <p><br></p>
      <h3>Options considered</h3>
      <ol><li><br></li></ol>
      <h3>Decision</h3>
      <p><br></p>
      <h3>Consequences</h3>
      <ul><li><br></li></ul>
    `,
  },
  {
    id: 'weekly',
    name: 'Weekly review',
    icon: CalendarRange,
    description: 'Reflect on the week and plan ahead.',
    title: () => `Weekly review — ${todayShort()}`,
    html: () => `
      <h2>Weekly review — ${todayShort()}</h2>
      <h3>Wins of the week</h3>
      <ul><li><br></li></ul>
      <h3>Challenges</h3>
      <ul><li><br></li></ul>
      <h3>Lessons learned</h3>
      <ul><li><br></li></ul>
      <h3>Priorities for next week</h3>
      <ul><li data-list="unchecked"><br></li></ul>
    `,
  },
  {
    id: 'oneonone',
    name: '1-on-1',
    icon: Users,
    description: 'Talking points for a 1:1 conversation.',
    title: () => `1-on-1 — ${todayShort()}`,
    html: () => `
      <h2>1-on-1 — ${todayShort()}</h2>
      <p><strong>With:</strong> </p>
      <h3>Wins / highlights</h3>
      <ul><li><br></li></ul>
      <h3>Blockers</h3>
      <ul><li><br></li></ul>
      <h3>Feedback</h3>
      <p><br></p>
      <h3>Career / growth</h3>
      <p><br></p>
      <h3>Action items</h3>
      <ul><li data-list="unchecked"><br></li></ul>
    `,
  },
  {
    id: 'retro',
    name: 'Retrospective',
    icon: Repeat,
    description: 'What went well, what didn\'t, action items.',
    title: () => `Retrospective — ${todayShort()}`,
    html: () => `
      <h2>Retrospective — ${todayShort()}</h2>
      <h3>What went well 🟢</h3>
      <ul><li><br></li></ul>
      <h3>What didn't go well 🔴</h3>
      <ul><li><br></li></ul>
      <h3>What we learned 💡</h3>
      <ul><li><br></li></ul>
      <h3>Action items 🎯</h3>
      <ul><li data-list="unchecked"><br></li></ul>
    `,
  },
];

export function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id) || TEMPLATES[0];
}