import s from '../CallOverlay.module.css';

export function QualityBadge({ quality }) {
    const color = quality === 'good' ? '#4caf50' : quality === 'fair' ? '#ff9800' : quality === 'poor' ? '#f44336' : '#666';
    const label = quality === 'good' ? 'Good' : quality === 'fair' ? 'Fair' : quality === 'poor' ? 'Poor' : '...';
    return (
        <div className={s.qualityBadge}>
            <span className={s.qualityDot} style={{ background: color }} />
            <span className={s.qualityLabel}>{label}</span>
        </div>
    );
}

export function DeviceSelector({ devices, activeId, onSelect, onClose, label }) {
    return (
        <div className={s.deviceSelector}>
            <div className={s.deviceSelectorHeader}>
                <span>{label}</span>
                <button onClick={onClose} className={s.deviceSelectorClose}>&times;</button>
            </div>
            {devices.map(d => (
                <button
                    key={d.deviceId}
                    className={`${s.deviceOption} ${d.deviceId === activeId ? s.deviceOptionActive : ''}`}
                    onClick={() => { onSelect(d.deviceId); onClose(); }}
                >
                    {d.label || `Device ${d.deviceId.slice(0, 8)}`}
                </button>
            ))}
        </div>
    );
}
