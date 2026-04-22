import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../../AuthContext';

const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
    ]
};

/**
 * useMeetingState — WebRTC mesh hook for multi-participant meetings.
 *
 * Fixed WS format: server expects { type, data: { ... } } and sends { type, data: { ... } }.
 *
 * keepAliveOnUnmount: when true, don't send meeting_leave or stop streams on unmount (PiP mode).
 * existingStream: re-use a previous MediaStream when returning from PiP.
 */
export function useMeetingState({ meetingId, ws, initialMuted = false, initialVideoOff = false, keepAliveOnUnmount = false, existingStream = null }) {
    const { user } = useAuth();

    // Local media
    const [localStream, setLocalStream] = useState(null);
    const [screenStream, setScreenStream] = useState(null);
    const [muted, setMuted] = useState(initialMuted);
    const [videoOff, setVideoOff] = useState(initialVideoOff);
    const [screenSharing, setScreenSharing] = useState(false);

    // Participants: Map userId -> { userId, name, stream, muted, videoOff, raisedHand, role, screenSharing }
    const [participants, setParticipants] = useState(new Map());

    // Presenter: userId of whoever is screen-sharing (null = nobody)
    const [presenterId, setPresenterId] = useState(null);

    // UI
    const [activePanel, setActivePanel] = useState(null); // 'chat' | 'participants' | null
    const [messages, setMessages] = useState([]);
    const [status, setStatus] = useState('joining'); // joining | connecting | connected | ended | left
    const [raisedHand, setRaisedHand] = useState(false);
    const [connectionQualities, setConnectionQualities] = useState(new Map());
    const [mediaReady, setMediaReady] = useState(!!existingStream);

    // Refs
    const localStreamRef = useRef(null);
    const screenStreamRef = useRef(null);
    const pcsRef = useRef(new Map()); // userId -> RTCPeerConnection
    const pendingSignals = useRef(new Map()); // userId -> []
    const qualityTimerRef = useRef(null);
    const wsRef = useRef(ws);
    wsRef.current = ws;

    // Helper: send WS message in { type, data } format
    const wsSend = useCallback((type, data) => {
        if (wsRef.current && wsRef.current.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type, data }));
        }
    }, []);

    // Acquire local media on mount (skip if existingStream is provided)
    useEffect(() => {
        if (existingStream) {
            localStreamRef.current = existingStream;
            setLocalStream(existingStream);
            setMediaReady(true);
            return;
        }
        let stream;
        const constraints = {
            audio: true,
            video: !initialVideoOff,
        };
        navigator.mediaDevices.getUserMedia(constraints)
            .then(st => {
                stream = st;
                st.getAudioTracks().forEach(t => { t.enabled = !initialMuted; });
                localStreamRef.current = st;
                setLocalStream(st);
                setMediaReady(true);
            })
            .catch(() => {
                navigator.mediaDevices.getUserMedia({ audio: true })
                    .then(st => {
                        stream = st;
                        st.getAudioTracks().forEach(t => { t.enabled = !initialMuted; });
                        localStreamRef.current = st;
                        setLocalStream(st);
                        setVideoOff(true);
                        setMediaReady(true);
                    })
                    .catch(err => {
                        setMuted(true);
                        setVideoOff(true);
                        setMediaReady(true);
                        if (err?.name === 'NotAllowedError') {
                            alert('Camera/microphone access is blocked.\n\n1. Click the lock/tune icon in the address bar → allow camera & microphone\n2. If the setting is locked, your organization may be blocking it — contact your IT admin to whitelist this site');
                        }
                    });
            });
        return () => {
            // Only stop tracks if not keeping alive for PiP
            if (!keepAliveOnUnmount && stream) stream.getTracks().forEach(t => t.stop());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Device change detection — re-enumerate when devices are added/removed
    useEffect(() => {
        const handleChange = () => {
            navigator.mediaDevices.enumerateDevices().catch(() => { });
        };
        navigator.mediaDevices?.addEventListener('devicechange', handleChange);
        return () => navigator.mediaDevices?.removeEventListener('devicechange', handleChange);
    }, []);

    // Safety net: when localStream becomes available, add tracks to any peer connections that lack senders
    useEffect(() => {
        if (!localStreamRef.current) return;
        const stream = localStreamRef.current;
        for (const [peerId, pc] of pcsRef.current) {
            const senders = pc.getSenders().filter(s => s.track);
            if (senders.length === 0 && stream.getTracks().length > 0) {
                stream.getTracks().forEach(track => pc.addTrack(track, stream));
                // Renegotiate so remote peer receives the new tracks
                if (pc.signalingState === 'stable') {
                    pc.createOffer()
                        .then(offer => pc.setLocalDescription(offer))
                        .then(() => {
                            wsSend('meeting_signal', {
                                meetingId,
                                targetUserId: peerId,
                                signal: { type: 'offer', sdp: pc.localDescription },
                            });
                        })
                        .catch(console.error);
                }
            }
        }
    }, [localStream, meetingId, wsSend]);

    // Quality monitoring
    useEffect(() => {
        qualityTimerRef.current = setInterval(async () => {
            const qMap = new Map();
            for (const [userId, pc] of pcsRef.current) {
                try {
                    const stats = await pc.getStats();
                    let totalPacketLoss = 0, roundTripTime = 0, count = 0;
                    stats.forEach(s => {
                        if (s.type === 'inbound-rtp') {
                            const total = (s.packetsReceived || 0) + (s.packetsLost || 0);
                            const loss = total > 0 ? s.packetsLost / total : 0;
                            totalPacketLoss += loss;
                            count++;
                        }
                        if (s.type === 'candidate-pair' && s.state === 'succeeded') {
                            roundTripTime = (s.currentRoundTripTime || 0) * 1000;
                        }
                    });
                    const avgLoss = count > 0 ? totalPacketLoss / count : 0;
                    const quality = roundTripTime < 100 && avgLoss < 0.02 ? 'good'
                        : roundTripTime < 250 && avgLoss < 0.08 ? 'medium' : 'poor';
                    qMap.set(userId, quality);
                } catch { /* ignore */ }
            }
            setConnectionQualities(new Map(qMap));
        }, 5000);
        // Always clean up the interval (including in PiP mode)
        return () => clearInterval(qualityTimerRef.current);
    }, []);

    // Create a peer connection to a remote user
    const createPeerConnection = useCallback((remoteUserId, isInitiator) => {
        if (pcsRef.current.has(remoteUserId)) return pcsRef.current.get(remoteUserId);

        let pc;
        try {
            pc = new RTCPeerConnection(ICE_CONFIG);
        } catch (err) {
            console.error('Failed to create RTCPeerConnection:', err);
            return null;
        }
        pcsRef.current.set(remoteUserId, pc);

        // Add local tracks
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current));
        }

        // Handle remote tracks
        const remoteStream = new MediaStream();
        pc.ontrack = (e) => {
            remoteStream.addTrack(e.track);
            // Create new MediaStream ref so React components detect the change and re-render
            setParticipants(prev => {
                const next = new Map(prev);
                const existing = next.get(remoteUserId) || { userId: remoteUserId };
                next.set(remoteUserId, { ...existing, stream: new MediaStream(remoteStream.getTracks()) });
                return next;
            });
        };

        // ICE candidates
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                wsSend('meeting_signal', {
                    meetingId,
                    targetUserId: remoteUserId,
                    signal: { type: 'candidate', candidate: e.candidate },
                });
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                setParticipants(prev => {
                    const next = new Map(prev);
                    const p = next.get(remoteUserId);
                    if (p) next.set(remoteUserId, { ...p, stream: null });
                    return next;
                });
            }
            // Update status to connected once at least one peer is connected
            if (pc.connectionState === 'connected') {
                setStatus('connected');
            }
        };

        // If initiator, create offer
        if (isInitiator) {
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                    wsSend('meeting_signal', {
                        meetingId,
                        targetUserId: remoteUserId,
                        signal: { type: 'offer', sdp: pc.localDescription },
                    });
                })
                .catch(console.error);
        }

        return pc;
    }, [meetingId, wsSend]);

    // Flush any buffered signals for a peer
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
            wsSend('meeting_signal', {
                meetingId,
                targetUserId: fromUserId,
                signal: { type: 'answer', sdp: pc.localDescription },
            });
            await flushPendingSignals(fromUserId, pc);
        } else if (signal.type === 'answer') {
            if (pc.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                await flushPendingSignals(fromUserId, pc);
            }
        } else if (signal.type === 'candidate') {
            if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } else {
                const q = pendingSignals.current.get(fromUserId) || [];
                q.push(signal);
                pendingSignals.current.set(fromUserId, q);
            }
        }
    }, [meetingId, wsSend, flushPendingSignals]);

    // WebSocket message handler — handles { type, data } envelope from server
    const handleWsMessage = useCallback((msg) => {
        const { type, data } = msg;
        if (!data) return;

        switch (type) {
            case 'meeting_participant_joined': {
                // Server sends: { userId, fullName, avatar, username, existingPeers? }
                // existingPeers is an array of { userId, fullName, avatar, username } objects
                console.log('[meeting] participant_joined:', data.userId, 'existingPeers:', data.existingPeers?.length, 'hasLocalStream:', !!localStreamRef.current);
                if (data.existingPeers && Array.isArray(data.existingPeers)) {
                    // We are the new joiner — existingPeers is sent only to us
                    data.existingPeers.forEach(peer => {
                        if (!peer || !peer.userId) return;
                        const peerId = peer.userId;
                        const pc = createPeerConnection(peerId, false);
                        if (!pc) return;
                        pcsRef.current.set(peerId, pc);
                        // Add existing participants with their names
                        if (peerId !== user?.id) {
                            setParticipants(prev => {
                                const next = new Map(prev);
                                const existing = next.get(peerId) || {};
                                next.set(peerId, {
                                    userId: peerId,
                                    stream: null, muted: false, videoOff: false,
                                    raisedHand: false, role: 'participant',
                                    screenSharing: false,
                                    ...existing,
                                    name: peer.fullName || peer.username || existing.name || 'Participant',
                                });
                                return next;
                            });
                        }
                    });
                    setStatus(data.existingPeers.length > 0 ? 'connecting' : 'connected');
                }
                // Add participant to our list (could be us or a new peer)
                if (data.userId !== user?.id) {
                    setParticipants(prev => {
                        const next = new Map(prev);
                        const existing = next.get(data.userId) || {};
                        next.set(data.userId, {
                            userId: data.userId,
                            stream: null, muted: false, videoOff: false,
                            raisedHand: false, role: data.role || 'participant',
                            screenSharing: false,
                            ...existing,
                            name: data.fullName || data.username || existing.name || 'Participant',
                        });
                        return next;
                    });
                    // If we're an existing participant, initiate connection to the new joiner
                    if (!data.existingPeers) {
                        const pc = createPeerConnection(data.userId, true);
                        if (pc) pcsRef.current.set(data.userId, pc);
                    }
                }
                setStatus('connected');
                break;
            }
            case 'meeting_signal': {
                const { fromUserId, signal } = data;
                console.log('[meeting] received signal:', signal.type, 'from:', fromUserId);
                let pc = pcsRef.current.get(fromUserId);
                if (!pc) {
                    pc = createPeerConnection(fromUserId, false);
                    if (!pc) break;
                    pcsRef.current.set(fromUserId, pc);
                }
                handleSignal(fromUserId, pc, signal).catch(console.error);
                break;
            }
            case 'meeting_participant_left': {
                const { userId } = data;
                pcsRef.current.get(userId)?.close();
                pcsRef.current.delete(userId);
                setParticipants(prev => { const next = new Map(prev); next.delete(userId); return next; });
                if (presenterId === userId) setPresenterId(null);
                break;
            }
            case 'meeting_ended': {
                setStatus('ended');
                pcsRef.current.forEach(pc => pc.close());
                pcsRef.current.clear();
                break;
            }
            case 'meeting_muted': {
                setMuted(true);
                if (localStreamRef.current) {
                    localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = false; });
                }
                break;
            }
            case 'meeting_hand_raised': {
                const { userId, raised } = data;
                setParticipants(prev => {
                    const next = new Map(prev);
                    const p = next.get(userId);
                    if (p) next.set(userId, { ...p, raisedHand: raised });
                    return next;
                });
                break;
            }
            case 'meeting_track_state': {
                // Remote participant's track state changed
                const { userId, muted: isMuted, videoOff: isVideoOff, screenSharing: isScreenSharing } = data;
                setParticipants(prev => {
                    const next = new Map(prev);
                    const p = next.get(userId);
                    if (p) next.set(userId, { ...p, muted: isMuted, videoOff: isVideoOff, screenSharing: isScreenSharing });
                    return next;
                });
                if (isScreenSharing) setPresenterId(userId);
                else if (presenterId === userId) setPresenterId(null);
                break;
            }
            case 'meeting_message': {
                setMessages(prev => [...prev, data.message]);
                break;
            }
            case 'meeting_invite': {
                // Another user invited us to an ongoing meeting — ignore in room context
                break;
            }
            default: break;
        }
    }, [user, createPeerConnection, handleSignal, presenterId]);

    // Register WS message handler inside the hook (before join effect) to ensure
    // signals are captured from the moment we join
    useEffect(() => {
        if (!ws) return;
        const onMessage = (e) => {
            try {
                handleWsMessage(JSON.parse(e.data));
            } catch (err) {
                console.error('Meeting WS message error:', err);
            }
        };
        ws.addEventListener('message', onMessage);
        return () => ws.removeEventListener('message', onMessage);
    }, [ws, handleWsMessage]);

    // Send WS join on mount — wait for socket to be open AND media to be ready before sending
    useEffect(() => {
        if (!ws || !meetingId || !mediaReady) return;

        const sendJoin = () => wsSend('meeting_join', { meetingId });

        if (ws.readyState === WebSocket.OPEN) {
            sendJoin();
        } else if (ws.readyState === WebSocket.CONNECTING) {
            ws.addEventListener('open', sendJoin);
        }

        return () => {
            ws.removeEventListener('open', sendJoin);
            // If keepAliveOnUnmount (PiP mode), don't leave — the meeting stays active
            if (!keepAliveOnUnmount) {
                wsSend('meeting_leave', { meetingId });
                pcsRef.current.forEach(pc => pc.close());
                pcsRef.current.clear();
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ws, meetingId, mediaReady]);

    // Actions
    const toggleMute = useCallback(() => {
        setMuted(v => {
            const next = !v;
            if (localStreamRef.current) {
                localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !next; });
            }
            wsSend('meeting_track_state', { meetingId, muted: next, videoOff });
            return next;
        });
    }, [meetingId, videoOff, wsSend]);

    const toggleVideo = useCallback(async () => {
        const next = !videoOff;
        if (next) {
            // Turning video OFF — disable existing tracks
            if (localStreamRef.current) {
                localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = false; });
            }
        } else {
            // Turning video ON
            if (localStreamRef.current) {
                const existingTracks = localStreamRef.current.getVideoTracks();
                const liveTracks = existingTracks.filter(t => t.readyState === 'live');
                if (liveTracks.length > 0) {
                    // Re-enable existing live track
                    liveTracks.forEach(t => { t.enabled = true; });
                    // Force React to notice the stream changed so video element re-renders
                    setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
                } else {
                    // No live video track — remove any ended tracks and acquire new one
                    existingTracks.filter(t => t.readyState === 'ended').forEach(t => {
                        localStreamRef.current.removeTrack(t);
                    });
                    try {
                        const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
                        const newTrack = newStream.getVideoTracks()[0];
                        if (newTrack) {
                            localStreamRef.current.addTrack(newTrack);
                            // Add video track to all peer connections and renegotiate
                            for (const [peerId, pc] of pcsRef.current) {
                                pc.addTrack(newTrack, localStreamRef.current);
                                if (pc.signalingState === 'stable') {
                                    try {
                                        const offer = await pc.createOffer();
                                        await pc.setLocalDescription(offer);
                                        wsSend('meeting_signal', {
                                            meetingId,
                                            targetUserId: peerId,
                                            signal: { type: 'offer', sdp: pc.localDescription },
                                        });
                                    } catch (err) { console.error('Renegotiation failed:', err); }
                                }
                            }
                            setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
                        }
                    } catch (err) {
                        console.error('Failed to start video:', err);
                        return; // Don't change state if camera unavailable
                    }
                }
            }
        }
        setVideoOff(next);
        wsSend('meeting_track_state', { meetingId, muted, videoOff: next });
    }, [meetingId, muted, videoOff, wsSend]);

    const toggleScreenShare = useCallback(async () => {
        if (screenSharing) {
            if (screenStreamRef.current) {
                screenStreamRef.current.getTracks().forEach(t => t.stop());
                screenStreamRef.current = null;
            }
            setScreenSharing(false);
            setScreenStream(null);
            setPresenterId(null);
            wsSend('meeting_track_state', { meetingId, muted, videoOff, screenSharing: false });
            // Revert to camera on all peers (or null if no camera track)
            for (const [peerId, pc] of pcsRef.current) {
                const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
                const videoTrack = localStreamRef.current?.getVideoTracks()[0];
                if (videoSender) {
                    videoSender.replaceTrack(videoTrack || null).catch(() => { });
                }
            }
        } else {
            try {
                const ss = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                screenStreamRef.current = ss;
                setScreenStream(ss);
                setScreenSharing(true);
                setPresenterId(user?.id);
                const screenTrack = ss.getVideoTracks()[0];
                // Replace or add video track on all peers
                for (const [peerId, pc] of pcsRef.current) {
                    const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
                    if (videoSender) {
                        videoSender.replaceTrack(screenTrack).catch(() => { });
                    } else {
                        // No video sender (audio-only) — add screen track and renegotiate
                        pc.addTrack(screenTrack, ss);
                        if (pc.signalingState === 'stable') {
                            try {
                                const offer = await pc.createOffer();
                                await pc.setLocalDescription(offer);
                                wsSend('meeting_signal', {
                                    meetingId,
                                    targetUserId: peerId,
                                    signal: { type: 'offer', sdp: pc.localDescription },
                                });
                            } catch (err) { console.error('Screen share renegotiation failed:', err); }
                        }
                    }
                }
                screenTrack.onended = () => toggleScreenShare();
                wsSend('meeting_track_state', { meetingId, muted, videoOff, screenSharing: true });
            } catch { /* user cancelled */ }
        }
    }, [screenSharing, meetingId, muted, videoOff, wsSend, user?.id]);

    const raiseHand = useCallback(() => {
        const next = !raisedHand;
        setRaisedHand(next);
        wsSend('meeting_raise_hand', { meetingId, raised: next });
    }, [raisedHand, meetingId, wsSend]);

    const sendChatMessage = useCallback((text) => {
        if (!text.trim()) return;
        wsSend('meeting_chat', { meetingId, text: text.trim() });
    }, [meetingId, wsSend]);

    const endMeeting = useCallback(() => {
        wsSend('meeting_end', { meetingId });
        setStatus('ended');
    }, [meetingId, wsSend]);

    const leaveMeeting = useCallback(() => {
        wsSend('meeting_leave', { meetingId });
        setStatus('left');
    }, [meetingId, wsSend]);

    const muteParticipant = useCallback((userId) => {
        wsSend('meeting_mute_participant', { meetingId, targetUserId: userId });
    }, [meetingId, wsSend]);

    const addParticipant = useCallback((userId) => {
        wsSend('meeting_add_participant', { meetingId, targetUserId: userId });
    }, [meetingId, wsSend]);

    // Switch input device mid-call
    const switchAudioDevice = useCallback(async (deviceId) => {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
            const newTrack = newStream.getAudioTracks()[0];
            if (!newTrack) return;
            // Replace in peer connections
            pcsRef.current.forEach(pc => {
                const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
                if (sender) sender.replaceTrack(newTrack).catch(() => { });
            });
            // Replace in local stream
            if (localStreamRef.current) {
                localStreamRef.current.getAudioTracks().forEach(t => t.stop());
                localStreamRef.current.removeTrack(localStreamRef.current.getAudioTracks()[0]);
                localStreamRef.current.addTrack(newTrack);
            }
            newTrack.enabled = !muted;
        } catch (err) { console.error('switchAudioDevice:', err); }
    }, [muted]);

    const switchVideoDevice = useCallback(async (deviceId) => {
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
            const newTrack = newStream.getVideoTracks()[0];
            if (!newTrack) return;
            pcsRef.current.forEach(pc => {
                const sender = pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) sender.replaceTrack(newTrack).catch(() => { });
            });
            if (localStreamRef.current) {
                localStreamRef.current.getVideoTracks().forEach(t => t.stop());
                const oldTrack = localStreamRef.current.getVideoTracks()[0];
                if (oldTrack) localStreamRef.current.removeTrack(oldTrack);
                localStreamRef.current.addTrack(newTrack);
                setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
            }
            newTrack.enabled = !videoOff;
        } catch (err) { console.error('switchVideoDevice:', err); }
    }, [videoOff]);

    return {
        // State
        localStream, screenStream, muted, videoOff, screenSharing,
        participants, status, raisedHand, messages,
        activePanel, setActivePanel,
        connectionQualities, presenterId,
        // Actions
        toggleMute, toggleVideo, toggleScreenShare, raiseHand,
        sendChatMessage, endMeeting, leaveMeeting, muteParticipant, addParticipant,
        switchAudioDevice, switchVideoDevice,
        // WS message handler (MeetingRoom passes incoming WS msgs here)
        handleWsMessage,
    };
}
