import { useState, useEffect, useCallback } from 'react';

export default function useCallControls({ localStreamRef, pcRef, screenStreamRef, screenSenderRef, localVideoRef, remoteVideoRef, overlayRef }) {
    const [muted, setMuted] = useState(false);
    const [videoOff, setVideoOff] = useState(false);
    const [screenSharing, setScreenSharing] = useState(false);
    const [onHold, setOnHold] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [connectionQuality, setConnectionQuality] = useState('unknown');

    // Device switching
    const [audioDevices, setAudioDevices] = useState([]);
    const [videoDevices, setVideoDevices] = useState([]);
    const [activeAudioDevice, setActiveAudioDevice] = useState('');
    const [activeVideoDevice, setActiveVideoDevice] = useState('');
    const [showAudioDevices, setShowAudioDevices] = useState(false);
    const [showVideoDevices, setShowVideoDevices] = useState(false);

    // ─── Connection quality monitor ───
    const startQualityMonitor = useCallback((pc) => {
        const interval = setInterval(async () => {
            try {
                const stats = await pc.getStats();
                let rtt = null, packetsLost = 0, packetsReceived = 0;
                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                        rtt = report.currentRoundTripTime;
                    }
                    if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                        packetsLost = report.packetsLost || 0;
                        packetsReceived = report.packetsReceived || 0;
                    }
                });
                const lossRate = packetsReceived > 0 ? packetsLost / (packetsLost + packetsReceived) : 0;
                if (rtt !== null && rtt < 0.15 && lossRate < 0.02) setConnectionQuality('good');
                else if (rtt !== null && rtt < 0.4 && lossRate < 0.05) setConnectionQuality('fair');
                else if (rtt !== null) setConnectionQuality('poor');
            } catch { /* stats unavailable */ }
        }, 3000);
        return interval;
    }, []);

    // ─── Enumerate devices ───
    useEffect(() => {
        async function loadDevices() {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                setAudioDevices(devices.filter(d => d.kind === 'audioinput'));
                setVideoDevices(devices.filter(d => d.kind === 'videoinput'));
            } catch { /* ignore */ }
        }
        loadDevices();
        navigator.mediaDevices?.addEventListener?.('devicechange', loadDevices);
        return () => navigator.mediaDevices?.removeEventListener?.('devicechange', loadDevices);
    }, []);

    // ─── Fullscreen listener ───
    useEffect(() => {
        const handler = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', handler);
        return () => document.removeEventListener('fullscreenchange', handler);
    }, []);

    // Sync screen share stream to video element when it mounts (audio call case)
    useEffect(() => {
        if (screenSharing && screenStreamRef.current && localVideoRef.current && !localVideoRef.current.srcObject) {
            localVideoRef.current.srcObject = screenStreamRef.current;
        }
    }, [screenSharing]);

    const toggleMute = () => {
        if (localStreamRef.current) {
            localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
            setMuted(!muted);
        }
    };

    const toggleVideo = () => {
        if (localStreamRef.current) {
            localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
            setVideoOff(!videoOff);
        }
    };

    const toggleScreenShare = async () => {
        if (!pcRef.current) return;

        if (screenSharing) {
            if (screenStreamRef.current) {
                screenStreamRef.current.getTracks().forEach(t => t.stop());
                screenStreamRef.current = null;
            }
            const camTrack = localStreamRef.current?.getVideoTracks()[0];
            if (camTrack && screenSenderRef.current) {
                await screenSenderRef.current.replaceTrack(camTrack);
            } else if (screenSenderRef.current && !camTrack) {
                pcRef.current.removeTrack(screenSenderRef.current);
                screenSenderRef.current = null;
            }
            if (localVideoRef.current && localStreamRef.current) {
                localVideoRef.current.srcObject = localStreamRef.current;
            }
            setScreenSharing(false);
        } else {
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { cursor: 'always' }, audio: false
                });
                screenStreamRef.current = screenStream;
                const screenTrack = screenStream.getVideoTracks()[0];

                if (screenSenderRef.current) {
                    await screenSenderRef.current.replaceTrack(screenTrack);
                } else {
                    const sender = pcRef.current.addTrack(screenTrack, screenStream);
                    screenSenderRef.current = sender;
                }

                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = screenStream;
                }

                screenTrack.onended = () => { toggleScreenShare(); };
                setScreenSharing(true);
            } catch (err) {
                console.error('Screen share failed:', err);
            }
        }
    };

    const toggleHold = () => {
        if (!localStreamRef.current) return;
        const hold = !onHold;
        localStreamRef.current.getTracks().forEach(t => { t.enabled = !hold; });
        setOnHold(hold);
        if (hold) { setMuted(true); setVideoOff(true); }
        else { setMuted(false); setVideoOff(false); }
    };

    const toggleFullscreen = async () => {
        try {
            if (!document.fullscreenElement) {
                await overlayRef.current?.requestFullscreen();
            } else {
                await document.exitFullscreen();
            }
        } catch { /* fullscreen not supported */ }
    };

    const togglePiP = async () => {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (remoteVideoRef.current) {
                await remoteVideoRef.current.requestPictureInPicture();
            }
        } catch { /* PiP not supported */ }
    };

    const switchAudioDevice = async (deviceId) => {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
            const newTrack = newStream.getAudioTracks()[0];
            const oldTrack = localStreamRef.current?.getAudioTracks()[0];
            const sender = pcRef.current?.getSenders().find(s => s.track?.kind === 'audio');
            if (sender) await sender.replaceTrack(newTrack);
            if (oldTrack) { localStreamRef.current.removeTrack(oldTrack); oldTrack.stop(); }
            localStreamRef.current?.addTrack(newTrack);
            setActiveAudioDevice(deviceId);
        } catch (err) { console.error('Switch mic failed:', err); }
    };

    const switchVideoDevice = async (deviceId) => {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: deviceId }, width: 1280, height: 720 }
            });
            const newTrack = newStream.getVideoTracks()[0];
            const oldTrack = localStreamRef.current?.getVideoTracks()[0];
            if (screenSenderRef.current && !screenSharing) {
                await screenSenderRef.current.replaceTrack(newTrack);
            }
            if (oldTrack) { localStreamRef.current.removeTrack(oldTrack); oldTrack.stop(); }
            localStreamRef.current?.addTrack(newTrack);
            if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
            setActiveVideoDevice(deviceId);
        } catch (err) { console.error('Switch camera failed:', err); }
    };

    return {
        muted, videoOff, screenSharing, onHold, isFullscreen, connectionQuality,
        audioDevices, videoDevices, activeAudioDevice, activeVideoDevice,
        showAudioDevices, setShowAudioDevices, showVideoDevices, setShowVideoDevices,
        toggleMute, toggleVideo, toggleScreenShare, toggleHold, toggleFullscreen, togglePiP,
        switchAudioDevice, switchVideoDevice,
        startQualityMonitor
    };
}
