/* ─────────────────────────────────────────────────────────
   Notes templates — used by the Home screen quick-action tiles
   and the empty-state template picker. Each template renders
   directly into Quill's HTML-compatible content.
   ───────────────────────────────────────────────────────── */

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

export const TEMPLATES = [
    {
        id: 'blank',
        name: 'Blank page',
        icon: '＋',
        description: 'Start from scratch.',
        title: () => 'Untitled',
        html: () => '',
    },
    {
        id: 'journal',
        name: "Today's journal",
        icon: '📓',
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
        icon: '🤝',
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
        icon: '✅',
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
        icon: '📆',
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
        icon: '👥',
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
        icon: '🔄',
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