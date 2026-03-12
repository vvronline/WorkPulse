import s from './FilePreview.module.css';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];

function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(type) {
    if (IMAGE_TYPES.includes(type)) return '🖼️';
    if (type?.startsWith('audio/')) return '🎵';
    if (type?.startsWith('video/')) return '🎬';
    if (type?.includes('pdf')) return '📄';
    if (type?.includes('spreadsheet') || type?.includes('excel')) return '📊';
    if (type?.includes('document') || type?.includes('word')) return '📝';
    if (type?.includes('zip') || type?.includes('compressed')) return '📦';
    return '📎';
}

export default function FilePreview({ fileUrl, fileName, fileType, fileSize, isMessage }) {
    const isImage = IMAGE_TYPES.includes(fileType);
    const isAudio = fileType?.startsWith('audio/');

    if (isImage && isMessage) {
        return (
            <a href={fileUrl} target="_blank" rel="noopener noreferrer" className={s.imgWrap}>
                <img src={fileUrl} alt={fileName} className={s.image} loading="lazy" />
            </a>
        );
    }

    if (isAudio && isMessage) {
        return (
            <div className={s.audioWrap}>
                <audio controls preload="metadata" className={s.audio}>
                    <source src={fileUrl} type={fileType} />
                </audio>
            </div>
        );
    }

    return (
        <a href={fileUrl} target="_blank" rel="noopener noreferrer" className={s.file}>
            <span className={s.icon}>{fileIcon(fileType)}</span>
            <div className={s.info}>
                <span className={s.name}>{fileName || 'File'}</span>
                {fileSize > 0 && <span className={s.size}>{formatSize(fileSize)}</span>}
            </div>
        </a>
    );
}
