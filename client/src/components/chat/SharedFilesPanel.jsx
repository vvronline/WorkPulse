import { useState, useEffect } from 'react';
import s from './SharedFilesPanel.module.css';
import { getSharedFiles } from '../../api';
import FilePreview from './FilePreview';

export default function SharedFilesPanel({ convId, onClose }) {
    const [files, setFiles] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!convId) return;
        setLoading(true);
        getSharedFiles(convId)
            .then(({ data }) => setFiles(data))
            .catch(() => setFiles([]))
            .finally(() => setLoading(false));
    }, [convId]);

    return (
        <div className={s.panel}>
            <div className={s.header}>
                <h4>Shared Files</h4>
                <button className={s.close} onClick={onClose}>✕</button>
            </div>
            <div className={s.list}>
                {loading && <div className={s.hint}>Loading...</div>}
                {!loading && files.length === 0 && <div className={s.hint}>No files shared yet</div>}
                {files.map(f => (
                    <div key={f.id} className={s.fileItem}>
                        <FilePreview
                            fileUrl={f.file_url}
                            fileName={f.file_name}
                            fileType={f.file_type}
                            fileSize={f.file_size}
                        />
                        <div className={s.fileMeta}>
                            <span className={s.sender}>{f.sender_name}</span>
                            <span className={s.date}>
                                {new Date(f.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
