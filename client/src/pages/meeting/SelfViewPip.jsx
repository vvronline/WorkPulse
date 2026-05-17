import React, { useRef, useEffect, useState } from 'react';

export default function SelfViewPip({ participant }) {
    const videoRef = useRef(null);
    const pipRef = useRef(null);
    const dragState = useRef(null);
    const [pos, setPos] = useState({ right: 16, bottom: 16 });

    const { stream, name, videoOff } = participant || {};

    useEffect(() => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream && !videoOff ? stream : null;
    }, [stream, videoOff]);

    useEffect(() => {
        const onMove = (e) => {
            if (!dragState.current) return;
            e.preventDefault();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const dx = clientX - dragState.current.startX;
            const dy = clientY - dragState.current.startY;
            setPos({
                right: Math.max(8, dragState.current.origRight - dx),
                bottom: Math.max(8, dragState.current.origBottom - dy),
            });
        };
        const onUp = () => { dragState.current = null; };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', onUp);
        };
    }, []);

    const onDragStart = (e) => {
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        dragState.current = {
            startX: clientX,
            startY: clientY,
            origRight: pos.right,
            origBottom: pos.bottom,
        };
    };

    const initial = (name || '?').charAt(0).toUpperCase();

    return (
        <div
            ref={pipRef}
            className="mr-self-pip"
            style={{ right: pos.right, bottom: pos.bottom }}
            onMouseDown={onDragStart}
            onTouchStart={onDragStart}
        >
            {stream && !videoOff ? (
                <video ref={videoRef} autoPlay playsInline muted />
            ) : (
                <>
                    <div className="mr-self-pip-avatar">{initial}</div>
                    <video ref={videoRef} style={{ display: 'none' }} />
                </>
            )}
            <div className="mr-self-pip-name">{name || 'You'}</div>
        </div>
    );
}
