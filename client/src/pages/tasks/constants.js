import hljs from '../../hljs-setup';

export const PRIORITIES = [
    { value: 'high', label: 'High', icon: '🔴', color: 'var(--danger)' },
    { value: 'medium', label: 'Medium', icon: '🟡', color: 'var(--warning)' },
    { value: 'low', label: 'Low', icon: '🟢', color: 'var(--success)' },
];

export const COLUMNS = [
    { id: 'pending', label: 'To Do', icon: '○', color: 'var(--text-muted)' },
    { id: 'in_progress', label: 'In Progress', icon: '◐', color: 'var(--warning)' },
    { id: 'in_review', label: 'In Review', icon: '◑', color: 'var(--primary-light)' },
    { id: 'done', label: 'Done', icon: '●', color: 'var(--success)' },
];

export const COMMENT_QUILL_MODULES = {
    toolbar: [
        ['bold', 'italic', 'underline', 'strike'],
        ['code-block'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['link'],
        ['clean'],
    ],
    syntax: { highlight: (text) => hljs.highlightAuto(text).value },
};
