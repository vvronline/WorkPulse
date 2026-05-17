import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../../AuthContext';
import { getIceConfig, uploadChatFile } from '../../api';

const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

function buildMeetingMediaProfiles(wantVideo) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (!wantVideo) return [{ audio, video: false }];
    return [
        { audio, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } },
        { audio, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } },
        { audio, video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 24 } } },
        { audio, video: true },
        { audio, video: false },
    ];
}

async function acquireMeetingMedia(wantVideo) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('NoMediaDevices');
    const profiles = buildMeetingMediaProfiles(wantVideo);
    let lastError;
    for (let i = 0; i < profiles.length; i++) {
        try {
            const st = await navigator.mediaDevices.getUserMedia(profiles[i]);
            if (i > 0) console.warn('[meeting] media acquired with reduced profile #' + i);
            return st;
        } catch (err) { lastError = err; }
    }
    throw lastError;
}

/**
 * Core meeting state hook — handles media, WebRTC mesh, signaling, and chat.
 * Optimized: no background effects, stable WS handler (no presenterId dep).
 */
export function useMeetingState({ meetingId, ws, initialMuted = false, initialVideoOff = false, keepAliveOnUnmount = false, existingStream = null }) {
    const { user } = useAuth();

    const [localStream, setLocalStream] = useState(null);
    const [screenStream, setScreenStream] = useState(null);
    const [muted, setMuted] = useState(initialMuted);
    const [videoOff, setVideoOff] = useState(initialVideoOff);
    const [screenSharing, setScreenSharing] = useState(false);
    const [participants, setParticipants] = useState(new Map());
    const [presenterId, setPresenterId] = useState(null);
    const [activePanel, setActivePanel] = useState(null);
    const [messages, setMessages] = useState([]);
    const [status, setStatus] = useState('joining');
    const [raisedHand, setRaisedHand] = useState(false);
    const [connectionQualities, setConnectionQualities] = useState(new Map());
    const [mediaReady, setMediaReady] = useState(!!existingStream);

    const localStreamRef = useRef(null);
    const screenStreamRef = useRef(null);
    const pcsRef = useRef(new Map());
    const pendingSignals = useRef(new Map());
    const qualityTimerRef = useRef(null);
    const wsRef = useRef(ws);
    wsRef.current = ws;
    const iceServersRef = useRef(DEFAULT_ICE_SERVERS);
    const iceExpiresAtRef = useRef(0);
    const relayOnlyPeersRef = useRef(new Set());
    const iceRestartCountsRef = useRef(new Map());
    const presenterIdRef = useRef(presenterId);
    presenterIdRef.current = presenterId;
    const mutedRef = useRef(muted);
    mutedRef.current = muted;
    const videoOffRef = useRef(videoOff);
    videoOffRef.current = videoOff;
    const screenSharingRef = useRef(screenSharing);
    screenSharingRef.current = screenSharing;

    const replaceVideoTrackOnPeers = useCallback(async (newTrack) => {
        const tasks = [];
        for (const [, pc] of pcsRef.current) {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) tasks.push(sender.replaceTrack(newTrack || null).catch(() => { }));
        }
        await Promise.all(tasks);
    }, []);

    const wsSend = useCallback((type, data) => {
        if (wsRef.current && wsRef.current.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type, data }));
        }
    }, []);

    // Acquire local media
    useEffect(() => {
        if (existingStream) {
            localStreamRef.current = existingStream;
            setLocalStream(existingStream);
            setMediaReady(true);
            return;
        }
        let stream;
        let cancelled = false;
        (async () => {
            try {
                const st = await acquireMeetingMedia(!initialVideoOff);
                if (cancelled) { st.getTracks().forEach(t => t.stop()); return; }
                stream = st;
                st.getAudioTracks().forEach(t => { t.enabled = !initialMuted; });
                if (st.getVideoTracks().length === 0) setVideoOff(true);
                localStreamRef.current = st;
                setLocalStream(st);
                setMediaReady(true);
            } catch (err) {
                if (cancelled) return;
                setMuted(true);
                setVideoOff(true);
                setMediaReady(true);
            }
        })();
        return () => {
            cancelled = true;
            if (!keepAliveOnUnmount && stream) stream.getTracks().forEach(t => t.stop());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Fetch ICE config
    useEffect(() => {
        const refresh = async () => {
            try {
                const { data } = await getIceConfig();
                if (data?.iceServers?.length) {
                    iceServersRef.current = data.iceServers;
                    iceExpiresAtRef.current = data.expiresAt || 0;
                }
            } catch { /* defaults */ }
        };
        refresh();
        const t = setInterval(() => {
            if (iceExpiresAtRef.current && iceExpiresAtRef.current - Math.floor(Date.now() / 1000) < 300) refresh();
        }, 60_000);
        return () => clearInterval(t);
    }, []);

    // Safety net: add tracks to peer connections
    useEffect(() => {
        if (!localStreamRef.current) return;
        const stream = localStreamRef.current;
        for (const [peerId, pc] of pcsRef.current) {
            const senders = pc.getSenders().filter(s => s.track);
            if (senders.length === 0 && stream.getTracks().length > 0) {
                stream.getTracks().forEach(track => pc.addTrack(track, stream));
                if (pc.signalingState === 'stable') {
                    pc.createOffer()
                        .then(offer => pc.setLocalDescription(offer))
                        .then(() => wsSend('meeting_signal', { meetingId, targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription } }))
                        .catch(console.error);
                }
            }
        }
    }, [localStream, meetingId, wsSend]);

    // Quality monitoring (every 8s for smoothness)
    useEffect(() => {
        qualityTimerRef.current = setInterval(async () => {
            const qMap = new Map();
            for (const [userId, pc] of pcsRef.current) {
                try {
                    const stats = await pc.getStats();
                    let totalPacketLoss = 0, rtt = 0, count = 0;
                    stats.forEach(s => {
                        if (s.type === 'inbound-rtp') {
                            const total = (s.packetsReceived || 0) + (s.packetsLost || 0);
                            if (total > 0) { totalPacketLoss += s.packetsLost / total; count++; }
                        }
                        if (s.type === 'candidate-pair' && s.state === 'succeeded') rtt = (s.currentRoundTripTime || 0) * 1000;
                    });
                    const avgLoss = count > 0 ? totalPacketLoss / count : 0;
                    qMap.set(userId, rtt < 100 && avgLoss < 0.02 ? 'good' : rtt < 250 && avgLoss < 0.08 ? 'medium' : 'poor');
                } catch { /* ignore */ }
            }
            setConnectionQualities(new Map(qMap));
        }, 8000);
        return () => clearInterval(qualityTimerRef.current);
    }, []);

    // Create peer connection
    const createPeerConnection = useCallback((remoteUserId, isInitiator) => {
        const existing = pcsRef.current.get(remoteUserId);
        if (existing && existing.connectionState !== 'closed' && existing.connectionState !== 'failed') return existing;
        if (existing) { try { existing.close(); } catch { } }

        const pcConfig = {
            iceServers: iceServersRef.current,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            iceCandidatePoolSize: 4,
        };
        if (relayOnlyPeersRef.current.has(remoteUserId)) pcConfig.iceTransportPolicy = 'relay';

        let pc;
        try { pc = new RTCPeerConnection(pcConfig); }
        catch { return null; }
        pcsRef.current.set(remoteUserId, pc);

        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current));
        }

        // Bitrate caps for smooth video
        setTimeout(() => {
            for (const sender of pc.getSenders()) {
                if (!sender.track) continue;
                try {
                    const params = sender.getParameters();
                    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
                    if (sender.track.kind === 'video') {
                        params.encodings[0].maxBitrate = 1_200_000;
                        params.degradationPreference = 'maintain-framerate';
                    } else {
                        params.encodings[0].maxBitrate = 64_000;
                    }
                    sender.setParameters(params).catch(() => { });
                } catch { /* ignore */ }
            }
        }, 0);

        const remoteStream = new MediaStream();
        pc.ontrack = (e) => {
            remoteStream.addTrack(e.track);
            setParticipants(prev => {
                const next = new Map(prev);
                const ex = next.get(remoteUserId) || { userId: remoteUserId };
                next.set(remoteUserId, { ...ex, stream: new MediaStream(remoteStream.getTracks()) });
                return next;
            });
        };

        pc.onicecandidate = (e) => {
            if (e.candidate) wsSend('meeting_signal', { meetingId, targetUserId: remoteUserId, signal: { type: 'candidate', candidate: e.candidate } });
        };

        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'disconnected') {
                setTimeout(() => {
                    if (pc.iceConnectionState === 'disconnected' && pc.signalingState === 'stable') {
                        const cnt = iceRestartCountsRef.current.get(remoteUserId) || 0;
                        if (cnt < 3) {
                            iceRestartCountsRef.current.set(remoteUserId, cnt + 1);
                            pc.createOffer({ iceRestart: true })
                                .then(o => pc.setLocalDescription(o))
                                .then(() => wsSend('meeting_signal', { meetingId, targetUserId: remoteUserId, signal: { type: 'offer', sdp: pc.localDescription } }))
                                .catch(() => { });
                        }
                    }
                }, 2000);
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
                setStatus('connected');
                iceRestartCountsRef.current.delete(remoteUserId);
                if (pc._disconnectTimer) { clearTimeout(pc._disconnectTimer); pc._disconnectTimer = null; }
            } else if (pc.connectionState === 'failed') {
                setParticipants(prev => { const n = new Map(prev); const p = n.get(remoteUserId); if (p) n.set(remoteUserId, { ...p, stream: null }); return n; });
                if (!relayOnlyPeersRef.current.has(remoteUserId)) {
                    relayOnlyPeersRef.current.add(remoteUserId);
                    try { pc.close(); } catch { }
                    pcsRef.current.delete(remoteUserId);
                    setTimeout(() => createPeerConnection(remoteUserId, true), 500);
                }
            } else if (pc.connectionState === 'disconnected') {
                pc._disconnectTimer = setTimeout(() => {
                    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                        setParticipants(prev => { const n = new Map(prev); const p = n.get(remoteUserId); if (p) n.set(remoteUserId, { ...p, stream: null }); return n; });
                    }
                }, 5000);
            }
        };

        if (isInitiator) {
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => wsSend('meeting_signal', { meetingId, targetUserId: remoteUserId, signal: { type: 'offer', sdp: pc.localDescription } }))
                .catch(console.error);
        }
        return pc;
    }, [meetingId, wsSend]);

    // Network change → ICE restart
    useEffect(() => {
        const restartAll = () => {
            for (const [peerId, pc] of pcsRef.current) {
                if (pc.signalingState !== 'stable') continue;
                pc.createOffer({ iceRestart: true })
                    .then(o => pc.setLocalDescription(o))
                    .then(() => wsSend('meeting_signal', { meetingId, targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription } }))
                    .catch(() => { });
            }
        };
        window.addEventListener('online', restartAll);
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        conn?.addEventListener?.('change', restartAll);
        return () => { window.removeEventListener('online', restartAll); conn?.removeEventListener?.('change', restartAll); };
    }, [meetingId, wsSend]);

    const flushPendingSignals = useCallback(async (userId, pc) => {
        const pending = pendingSignals.current.get(userId) || [];
        pendingSignals.current.delete(userId);
        for (const sig of pending) {
            try { await handleSignal(userId, pc, sig); } catch { /* ignore */ }
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleSignal = useCallback(async (fromUserId, pc, signal) => {
        if (!pc) return;
        if (signal.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            wsSend('meeting_signal', { meetingId, targetUserId: fromUserId, signal: { type: 'answer', sdp: pc.localDescription } });
            await flushPendingSignals(fromUserId, pc);
        } else if (signal.type === 'answer') {
            if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                await flushPendingSignals(fromUserId, pc);
            }
        } else if (signal.type === 'candidate') {
            if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            else { const q = pendingSignals.current.get(fromUserId) || []; q.push(signal); pendingSignals.current.set(fromUserId, q); }
        }
    }, [meetingId, wsSend, flushPendingSignals]);

    // STABLE WS handler — uses presenterIdRef instead of presenterId state
    const handleWsMessage = useCallback((msg) => {
        const { type, data } = msg;
        if (!data) return;
        switch (type) {
            case 'meeting_participant_joined': {
                if (data.existingPeers && Array.isArray(data.existingPeers)) {
                    data.existingPeers.forEach(peer => {
                        if (!peer?.userId) return;
                        const pc = createPeerConnection(peer.userId, false);
                        if (pc) pcsRef.current.set(peer.userId, pc);
                        if (peer.userId !== user?.id) {
                            setParticipants(prev => {
                                const next = new Map(prev);
                                next.set(peer.userId, { userId: peer.userId, stream: null, muted: false, videoOff: false, raisedHand: false, role: 'participant', screenSharing: false, ...(next.get(peer.userId) || {}), name: peer.fullName || peer.username || 'Participant' });
                                return next;
                            });
                        }
                    });
                    setStatus(data.existingPeers.length > 0 ? 'connecting' : 'connected');
                }
                if (data.userId !== user?.id) {
                    setParticipants(prev => {
                        const next = new Map(prev);
                        next.set(data.userId, { userId: data.userId, stream: null, muted: false, videoOff: false, raisedHand: false, role: data.role || 'participant', screenSharing: false, ...(next.get(data.userId) || {}), name: data.fullName || data.username || 'Participant' });
                        return next;
                    });
                    if (!data.existingPeers) {
                        const pc = createPeerConnection(data.userId, true);
                        if (pc) pcsRef.current.set(data.userId, pc);
                        wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: screenSharingRef.current });
                    }
                }
                setStatus('connected');
                break;
            }
            case 'meeting_signal': {
                const { fromUserId, signal } = data;
                let pc = pcsRef.current.get(fromUserId);
                if (!pc) { pc = createPeerConnection(fromUserId, false); if (!pc) break; pcsRef.current.set(fromUserId, pc); }
                handleSignal(fromUserId, pc, signal).catch(console.error);
                break;
            }
            case 'meeting_participant_left': {
                const { userId } = data;
                pcsRef.current.get(userId)?.close();
                pcsRef.current.delete(userId);
                setParticipants(prev => { const n = new Map(prev); n.delete(userId); return n; });
                if (presenterIdRef.current === userId) setPresenterId(null);
                break;
            }
            case 'meeting_ended': {
                if (screenStreamRef.current) { screenStreamRef.current.getTracks().forEach(t => t.stop()); screenStreamRef.current = null; }
                if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null; }
                pcsRef.current.forEach(pc => { try { pc.close(); } catch { } });
                pcsRef.current.clear();
                if (qualityTimerRef.current) { clearInterval(qualityTimerRef.current); qualityTimerRef.current = null; }
                setStatus('ended');
                break;
            }
            case 'meeting_muted': {
                const shouldMute = data.muted !== false;
                setMuted(shouldMute);
                if (localStreamRef.current) localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !shouldMute; });
                wsSend('meeting_track_state', { meetingId, muted: shouldMute, videoOff: videoOffRef.current, screenSharing: screenSharingRef.current });
                break;
            }
            case 'meeting_hand_raised': {
                const { userId, raised } = data;
                setParticipants(prev => { const n = new Map(prev); const p = n.get(userId); if (p) n.set(userId, { ...p, raisedHand: raised }); return n; });
                break;
            }
            case 'meeting_track_state': {
                const { userId, muted: m, videoOff: v, screenSharing: s } = data;
                setParticipants(prev => {
                    const n = new Map(prev);
                    const p = n.get(userId);
                    if (p) {
                        n.set(userId, {
                            ...p,
                            ...(m != null ? { muted: m } : {}),
                            ...(v != null ? { videoOff: v } : {}),
                            ...(s != null ? { screenSharing: s } : {}),
                        });
                    }
                    return n;
                });
                if (s) setPresenterId(userId);
                else if (s === false && presenterIdRef.current === userId) setPresenterId(null);
                break;
            }
            case 'meeting_message': {
                const incoming = data.message;
                if (!incoming) break;
                setMessages(prev => {
                    if (incoming.sender_id === user?.id) {
                        const idx = prev.findIndex(m => m._optimistic && m.sender_id === incoming.sender_id && m.text === incoming.text);
                        if (idx >= 0) { const next = prev.slice(); next[idx] = incoming; return next; }
                    }
                    return [...prev, incoming];
                });
                break;
            }
            default: break;
        }
    }, [user, createPeerConnection, handleSignal, meetingId, wsSend]);

    // Register WS message handler
    useEffect(() => {
        if (!ws) return;
        const onMessage = (e) => { try { handleWsMessage(JSON.parse(e.data)); } catch { /* ignore */ } };
        ws.addEventListener('message', onMessage);
        return () => ws.removeEventListener('message', onMessage);
    }, [ws, handleWsMessage]);

    // Send WS join
    useEffect(() => {
        if (!ws || !meetingId || !mediaReady) return;
        const sendJoin = () => {
            wsSend('meeting_join', { meetingId });
            setTimeout(() => wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: screenSharingRef.current }), 500);
        };
        if (ws.readyState === WebSocket.OPEN) sendJoin();
        else if (ws.readyState === WebSocket.CONNECTING) ws.addEventListener('open', sendJoin);
        return () => {
            ws.removeEventListener('open', sendJoin);
            if (!keepAliveOnUnmount) { wsSend('meeting_leave', { meetingId }); pcsRef.current.forEach(pc => pc.close()); pcsRef.current.clear(); }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ws, meetingId, mediaReady]);

    // Actions
    const toggleMute = useCallback(() => {
        setMuted(v => {
            const next = !v;
            if (localStreamRef.current) localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !next; });
            wsSend('meeting_track_state', { meetingId, muted: next, videoOff: videoOffRef.current, screenSharing: screenSharingRef.current });
            return next;
        });
    }, [meetingId, wsSend]);

    const toggleVideo = useCallback(async () => {
        const next = !videoOff;
        if (next) {
            if (localStreamRef.current) localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = false; });
        } else {
            if (localStreamRef.current) {
                const live = localStreamRef.current.getVideoTracks().filter(t => t.readyState === 'live');
                if (live.length > 0) {
                    live.forEach(t => { t.enabled = true; });
                    // Ensure peers have this track (may not if originally joined without video)
                    const vt = live[0];
                    for (const [peerId, pc] of pcsRef.current) {
                        const vs = pc.getSenders().find(s => s.track?.kind === 'video');
                        if (vs) {
                            await vs.replaceTrack(vt).catch(() => { });
                        } else {
                            pc.addTrack(vt, localStreamRef.current);
                            // Renegotiate so remote peer gets the new track
                            try {
                                const offer = await pc.createOffer();
                                await pc.setLocalDescription(offer);
                                wsSend('meeting_signal', { meetingId, targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription } });
                            } catch { /* ignore */ }
                        }
                    }
                    setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
                } else {
                    localStreamRef.current.getVideoTracks().filter(t => t.readyState === 'ended').forEach(t => localStreamRef.current.removeTrack(t));
                    try {
                        const ns = await navigator.mediaDevices.getUserMedia({ video: true });
                        const nt = ns.getVideoTracks()[0];
                        if (nt) {
                            localStreamRef.current.addTrack(nt);
                            for (const [peerId, pc] of pcsRef.current) {
                                const vs = pc.getSenders().find(s => s.track?.kind === 'video');
                                if (vs) {
                                    await vs.replaceTrack(nt).catch(() => { });
                                } else {
                                    pc.addTrack(nt, localStreamRef.current);
                                    // Renegotiate so remote peer gets the new track
                                    try {
                                        const offer = await pc.createOffer();
                                        await pc.setLocalDescription(offer);
                                        wsSend('meeting_signal', { meetingId, targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription } });
                                    } catch { /* ignore */ }
                                }
                            }
                            setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
                        }
                    } catch { return; }
                }
            } else {
                // No local stream at all — acquire fresh
                try {
                    const ns = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
                    localStreamRef.current = ns;
                    ns.getAudioTracks().forEach(t => { t.enabled = !mutedRef.current; });
                    for (const [peerId, pc] of pcsRef.current) {
                        ns.getTracks().forEach(track => pc.addTrack(track, ns));
                        try {
                            const offer = await pc.createOffer();
                            await pc.setLocalDescription(offer);
                            wsSend('meeting_signal', { meetingId, targetUserId: peerId, signal: { type: 'offer', sdp: pc.localDescription } });
                        } catch { /* ignore */ }
                    }
                    setLocalStream(ns);
                } catch { return; }
            }
        }
        setVideoOff(next);
        wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: next, screenSharing: screenSharingRef.current });
    }, [meetingId, videoOff, wsSend]);

    const toggleScreenShare = useCallback(async () => {
        if (screenSharing) {
            if (screenStreamRef.current) { screenStreamRef.current.getTracks().forEach(t => t.stop()); screenStreamRef.current = null; }
            setScreenSharing(false); setScreenStream(null); setPresenterId(null);
            wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: false });
            for (const [, pc] of pcsRef.current) {
                const vs = pc.getSenders().find(s => s.track?.kind === 'video');
                if (vs) vs.replaceTrack(localStreamRef.current?.getVideoTracks()[0] || null).catch(() => { });
            }
        } else {
            try {
                const ss = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                screenStreamRef.current = ss; setScreenStream(ss); setScreenSharing(true); setPresenterId(user?.id);
                const st = ss.getVideoTracks()[0];
                for (const [, pc] of pcsRef.current) {
                    const vs = pc.getSenders().find(s => s.track?.kind === 'video');
                    if (vs) vs.replaceTrack(st).catch(() => { });
                    else pc.addTrack(st, ss);
                }
                st.onended = () => toggleScreenShare();
                wsSend('meeting_track_state', { meetingId, muted: mutedRef.current, videoOff: videoOffRef.current, screenSharing: true });
            } catch { /* cancelled */ }
        }
    }, [screenSharing, meetingId, wsSend, user?.id]);

    const raiseHand = useCallback(() => { const next = !raisedHand; setRaisedHand(next); wsSend('meeting_raise_hand', { meetingId, raised: next }); }, [raisedHand, meetingId, wsSend]);

    const sendChatMessage = useCallback((text) => {
        if (!text.trim()) return;
        const trimmed = text.trim();
        setMessages(prev => [...prev, { sender_id: user?.id, sender_name: user?.full_name || user?.username || 'You', text: trimmed, created_at: new Date().toISOString(), _optimistic: true }]);
        wsSend('meeting_chat', { meetingId, text: trimmed });
    }, [meetingId, wsSend, user]);

    const sendChatFile = useCallback(async (file) => {
        const formData = new FormData();
        formData.append('file', file);
        try {
            // Optimistic local message
            setMessages(prev => [...prev, {
                sender_id: user?.id,
                sender_name: user?.full_name || user?.username || 'You',
                file_name: file.name,
                file_size: file.size,
                file_url: URL.createObjectURL(file),
                created_at: new Date().toISOString(),
                _optimistic: true,
            }]);
            // Upload and broadcast via WS
            const convId = sessionStorage.getItem('meeting_conv_id');
            if (convId) {
                const res = await uploadChatFile(convId, formData);
                wsSend('meeting_chat', { meetingId, file_url: res.data.fileUrl, file_name: res.data.fileName, file_size: res.data.fileSize });
            } else {
                wsSend('meeting_chat', { meetingId, text: `📎 ${file.name}`, file_name: file.name, file_size: file.size });
            }
        } catch { /* silent */ }
    }, [meetingId, wsSend, user]);

    const cleanupMedia = useCallback(() => {
        if (screenStreamRef.current) { screenStreamRef.current.getTracks().forEach(t => t.stop()); screenStreamRef.current = null; setScreenStream(null); }
        if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null; setLocalStream(null); }
        pcsRef.current.forEach(pc => { try { pc.close(); } catch { } }); pcsRef.current.clear();
        if (qualityTimerRef.current) { clearInterval(qualityTimerRef.current); qualityTimerRef.current = null; }
    }, []);

    const endMeeting = useCallback(() => { wsSend('meeting_end', { meetingId }); cleanupMedia(); setStatus('ended'); }, [meetingId, wsSend, cleanupMedia]);
    const leaveMeeting = useCallback(() => { wsSend('meeting_leave', { meetingId }); cleanupMedia(); setStatus('left'); }, [meetingId, wsSend, cleanupMedia]);
    const muteParticipant = useCallback((targetUserId, muted = true) => { wsSend('meeting_mute_participant', { meetingId, targetUserId, muted }); }, [meetingId, wsSend]);
    const addParticipant = useCallback((targetUserId) => { wsSend('meeting_add_participant', { meetingId, targetUserId }); }, [meetingId, wsSend]);

    const switchAudioDevice = useCallback(async (deviceId) => {
        try {
            const ns = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
            const nt = ns.getAudioTracks()[0];
            if (!nt || !localStreamRef.current) return;
            const old = localStreamRef.current.getAudioTracks()[0];
            if (old) { localStreamRef.current.removeTrack(old); old.stop(); }
            localStreamRef.current.addTrack(nt);
            nt.enabled = !mutedRef.current;
            for (const [, pc] of pcsRef.current) { const s = pc.getSenders().find(s => s.track?.kind === 'audio'); if (s) await s.replaceTrack(nt).catch(() => { }); }
            setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        } catch { /* ignore */ }
    }, []);

    const switchVideoDevice = useCallback(async (deviceId) => {
        try {
            const ns = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
            const nt = ns.getVideoTracks()[0];
            if (!nt || !localStreamRef.current) return;
            const old = localStreamRef.current.getVideoTracks()[0];
            if (old) { localStreamRef.current.removeTrack(old); old.stop(); }
            localStreamRef.current.addTrack(nt);
            nt.enabled = !videoOffRef.current;
            for (const [, pc] of pcsRef.current) { const s = pc.getSenders().find(s => s.track?.kind === 'video'); if (s) await s.replaceTrack(nt).catch(() => { }); }
            setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        } catch { /* ignore */ }
    }, []);

    return {
        localStream, screenStream, muted, videoOff, screenSharing,
        participants, status, raisedHand, messages,
        activePanel, setActivePanel, connectionQualities, presenterId,
        toggleMute, toggleVideo, toggleScreenShare, raiseHand,
        sendChatMessage, sendChatFile, endMeeting, leaveMeeting, muteParticipant, addParticipant,
        switchAudioDevice, switchVideoDevice, handleWsMessage,
    };
}
