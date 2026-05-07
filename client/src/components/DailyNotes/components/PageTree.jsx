/* ─────────────────────────────────────────────────────────
   PageTree — collapsible sub-page hierarchy navigation.
   Drop-in replacement for the flat list when sub-pages exist.
   ───────────────────────────────────────────────────────── */
import React, { useState, useCallback } from 'react';
import {
    ChevronRight, ChevronDown, FileText, Plus,
} from '../../../constants/icons';
import { buildPageTree } from '../notesUtils';
import s from './PageTree.module.css';

function TreeNode({
    node, activePageId, expanded, onToggle, onSelect, onAddChild, depth = 0,
}) {
    const isOpen = expanded[node.id] !== false; // default open
    const hasChildren = node.children?.length > 0;

    return (
        <li className={s.node}>
            <div
                className={`${s.row} ${node.id === activePageId ? s.rowActive : ''}`}
                style={{ paddingLeft: 6 + depth * 14 }}
            >
                {hasChildren ? (
                    <button
                        type="button"
                        className={s.chevron}
                        onClick={() => onToggle(node.id)}
                        aria-label={isOpen ? 'Collapse' : 'Expand'}
                    >
                        {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    </button>
                ) : (
                    <span className={s.chevronSpacer} />
                )}
                <button
                    type="button"
                    className={s.label}
                    onClick={() => onSelect(node.id)}
                    title={node.title}
                >
                    {node.icon
                        ? <span className={s.icon}>{node.icon}</span>
                        : <FileText size={12} className={s.icon} aria-hidden="true" />}
                    <span className={s.title}>{node.title || 'Untitled'}</span>
                </button>
                <button
                    type="button"
                    className={s.addBtn}
                    onClick={(e) => { e.stopPropagation(); onAddChild(node.id); }}
                    title="Add sub-page"
                    aria-label="Add sub-page"
                >
                    <Plus size={11} />
                </button>
            </div>
            {hasChildren && isOpen && (
                <ul className={s.children}>
                    {node.children.map(c => (
                        <TreeNode
                            key={c.id}
                            node={c}
                            activePageId={activePageId}
                            expanded={expanded}
                            onToggle={onToggle}
                            onSelect={onSelect}
                            onAddChild={onAddChild}
                            depth={depth + 1}
                        />
                    ))}
                </ul>
            )}
        </li>
    );
}

export default function PageTree({
    pages, activePageId, onSelect, onAddChild, onAddRoot,
}) {
    const tree = buildPageTree(pages, null, 0);
    const [expanded, setExpanded] = useState({});

    const onToggle = useCallback((id) => {
        setExpanded(prev => ({ ...prev, [id]: prev[id] === false ? true : false }));
    }, []);

    return (
        <div className={s.tree}>
            <div className={s.header}>
                <span>Pages</span>
                <button
                    type="button"
                    className={s.headerBtn}
                    onClick={() => onAddRoot?.()}
                    title="New root page"
                    aria-label="New root page"
                >
                    <Plus size={12} />
                </button>
            </div>
            <ul className={s.list}>
                {tree.map(n => (
                    <TreeNode
                        key={n.id}
                        node={n}
                        activePageId={activePageId}
                        expanded={expanded}
                        onToggle={onToggle}
                        onSelect={onSelect}
                        onAddChild={onAddChild}
                    />
                ))}
                {tree.length === 0 && (
                    <li className={s.empty}>No pages</li>
                )}
            </ul>
        </div>
    );
}