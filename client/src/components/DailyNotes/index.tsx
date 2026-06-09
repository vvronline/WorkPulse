/* eslint-disable @typescript-eslint/no-explicit-any */
/* DailyNotes/index.tsx — thin orchestrator */
import React from "react";
import ConfirmDialog from "../common/ConfirmDialog";
import { useNotesStore } from "./useNotesStore";
import NotesHeader from "./components/NotesHeader";
import NotesModal from "./components/NotesModal";
import s from "./index.module.css";

interface DailyNotesProps {
    userId?: any;
}

export default function DailyNotes({ userId }: DailyNotesProps) {
    const store = useNotesStore(userId) as any;
    if (!userId) return null;

    const {
        savedFlash,
        activePage,
        pages,
        maximized, setMaximized,
        confirmDelete, setConfirmDelete,
        handleConfirmDelete,
    } = store;

    return (
        <>
            <div className={s.root}>
                <NotesHeader
                    activePage={activePage}
                    pages={pages}
                    savedFlash={savedFlash}
                    onOpen={() => setMaximized(true)}
                />
            </div>

            {maximized && <NotesModal store={store} />}

            <ConfirmDialog
                isOpen={confirmDelete}
                title="Delete Page"
                message={`Are you sure you want to delete "${activePage?.title || "this page"}"? This action cannot be undone.`}
                confirmText="Delete"
                cancelText="Cancel"
                onConfirm={handleConfirmDelete}
                onCancel={() => setConfirmDelete(false)}
                isDanger
            />
        </>
    );
}