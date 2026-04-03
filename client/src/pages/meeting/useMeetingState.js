import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../../AuthContext';

const STUN_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

/**
 * useMeetingState — WebRTC mesh hook for multi-participant meetings.
 *
 * Returns state and actions for MeetingRoom.
 */
export function useMeetingState({ meetingId, ws, initialMuted = false, initialVideoOff = false }) {
    const { user } = useAuth();

    // Local media
    const [localStream, setLocalStream] = useState(null);
    const [screenStream, setScreenStream] = useState(null);
    const [muted, setMuted] = useState(initialMuted);
    const [videoOff, setVideoOff] = useState(initialVideoOff);
    const [screenSharing, setScreenSharing] = useState(false);

    // Participants: Map userId -> { userId, name, stream, muted, videoOff, raisedHand, role }
    const [participants, setParticipants] = useState(new Map());

    // UI
    const [activePanel, setActivePanel] = useState(null); // 'chat' | 'participants' | null
    const [messages, setMessages] = useState([]);
    const [status, setStatus] = useState('joining'); // joining | connected | ended
    const [raisedHand, setRaisedHand] = useState(false);
    const [connectionQualities, setConnectionQualities] = useState(new Map());

    // Refs
    const localStreamRef = useRef(null);
    const screenStreamRef = useRef(null);
    const pcsRef = useRef(new Map()); // userId -> RTCPeerConnection
    const pendingSignals = useRef(new Map()); // userId -> []
    const qualityTimerRef = useRef(null);

    // Acquire local media on mount
    useEffect(() => {
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
            })
            .catch(() => {
                // Try audio only
                navigator.mediaDevices.getUserMedia({ audio: true })
                    .then(st => {
                        stream = st;
                        st.getAudioTracks().forEach(t => { t.enabled = !initialMuted; });
                        localStreamRef.current = st;
                        setLocalStream(st);
                        setVideoOff(true);
                    })
                    .catch(() => {
                        setMuted(true);
                        setVideoOff(true);
                    });
            });
        return () => { if (stream) stream.getTracks().forEach(t => t.stop()); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
                            const loss = s.packetsLost / (s.packetsReceived + s.packetsLost || 1);
                            totalPacketLoss += loss;
                            count++;
                        }
                        if (s.type === 'candidate-pair' && s.state === 'succeeded') {
                            roundTripTime = s.currentRoundTripTime * 1000;
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
        return () => clearInterval(qualityTimerRef.current);
    }, []);

    // Create a peer connection to a remote user
    const createPeerConnection = useCallback((remoteUserId, isInitiator) => {
        if (pcsRef.current.has(remoteUserId)) return pcsRef.current.get(remoteUserId);

        const pc = new RTCPeerConnection(STUN_SERVERS);
        pcsRef.current.set(remoteUserId, pc);

        // Add local tracks
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current));
        }

        // Handle remote tracks
        const remoteStream = new MediaStream();
        pc.ontrack = (e) => {
            e.streams[0]?.getTracks().forEach(t => remoteStream.addTrack(t));
            setParticipants(prev => {
                const next = new Map(prev);
                const existing = next.get(remoteUserId) || { userId: remoteUserId };
                next.set(remoteUserId, { ...existing, stream: remoteStream });
                return next;
            });
        };

        // ICE candidates
        pc.onicecandidate = (e) => {
            if (e.candidate && ws) {
                ws.send(JSON.stringify({
                    type: 'meeting_signal',
                    meetingId,
                    targetUserId: remoteUserId,
                    signal: { type: 'candidate', candidate: e.candidate },
                }));
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
        };

        // If initiator, create offer
        if (isInitiator) {
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                    ws?.send(JSON.stringify({
                        type: 'meeting_signal',
                        meetingId,
                        targetUserId: remoteUserId,
                        signal: { type: 'offer', sdp: pc.localDescription },
                    }));
                })
                .catch(console.error);
        }

        return pc;
    }, [meetingId, ws]);

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
            ws?.send(JSON.stringify({
                type: 'meeting_signal',
                meetingId,
                targetUserId: fromUserId,
                signal: { type: 'answer', sdp: pc.localDescription },
            }));
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
    }, [meetingId, ws, flushPendingSignals]);

    // WebSocket message handler
    const handleWsMessage = useCallback((data) => {
        switch (data.type) {
            case 'meeting_joined': {
                // New participant joined — add to list and create PC as initiator
                setParticipants(prev => {
                    const next = new Map(prev);
                    if (!next.has(data.userId)) {
                        next.set(data.userId, { userId: data.userId, name: data.name, stream: null, muted: false, videoOff: false, raisedHand: false, role: data.role });
                    }
                    return next;
                });
                // We are an existing participant, so we are initiators
                if (data.userId !== user?.id) {
                    const pc = createPeerConnection(data.userId, true);
                    pcsRef.current.set(data.userId, pc);
                }
                setStatus('connected');
                break;
            }
            case 'meeting_existing_peers': {
                // Server sent list of peers already in the meeting (for new joiner)
                const peers = data.peers || [];
                peers.forEach(p => {
                    setParticipants(prev => {
                        const next = new Map(prev);
                        if (!next.has(p.userId)) {
                            next.set(p.userId, { userId: p.userId, name: p.name, stream: null, muted: false, videoOff: false, raisedHand: false, role: p.role });
                        }
                        return next;
                    });
                    // Existing peer will initiate, so we are receivers
                    const pc = createPeerConnection(p.userId, false);
                    pcsRef.current.set(p.userId, pc);
                });
                if (peers.length === 0) setStatus('connected');
                else setStatus('connecting');
                break;
            }
            case 'meeting_signal': {
                const { fromUserId, signal } = data;
                let pc = pcsRef.current.get(fromUserId);
                if (!pc) {
                    pc = createPeerConnection(fromUserId, false);
                    pcsRef.current.set(fromUserId, pc);
                }
                handleSignal(fromUserId, pc, signal).catch(console.error);
                break;
            }
            case 'meeting_left': {
                const { userId } = data;
                pcsRef.current.get(userId)?.close();
                pcsRef.current.delete(userId);
                setParticipants(prev => { const next = new Map(prev); next.delete(userId); return next; });
                break;
            }
            case 'meeting_ended': {
                setStatus('ended');
                pcsRef.current.forEach(pc => pc.close());
                pcsRef.current.clear();
                break;
            }
            case 'meeting_muted': {
                // Organizer forced mute
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
            case 'meeting_message': {
                setMessages(prev => [...prev, data.message]);
                break;
            }
            default: break;
        }
    }, [user, createPeerConnection, handleSignal]);

    // Send WS join on mount
    useEffect(() => {
        if (!ws || !meetingId) return;
        ws.send(JSON.stringify({ type: 'meeting_join', meetingId }));
        return () => {
            ws.send(JSON.stringify({ type: 'meeting_leave', meetingId }));
            pcsRef.current.forEach(pc => pc.close());
            pcsRef.current.clear();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ws, meetingId]);

    // Actions
    const toggleMute = useCallback(() => {
        setMuted(v => {
            const next = !v;
            if (localStreamRef.current) {
                localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !next; });
            }
            ws?.send(JSON.stringify({ type: 'meeting_track_state', meetingId, muted: next, videoOff }));
            return next;
        });
    }, [meetingId, videoOff, ws]);

    const toggleVideo = useCallback(() => {
        setVideoOff(v => {
            const next = !v;
            if (localStreamRef.current) {
                localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = !next; });
            }
            ws?.send(JSON.stringify({ type: 'meeting_track_state', meetingId, muted, videoOff: next }));
            return next;
        });
    }, [meetingId, muted, ws]);

    const toggleScreenShare = useCallback(async () => {
        if (screenSharing) {
            if (screenStreamRef.current) {
                screenStreamRef.current.getTracks().forEach(t => t.stop());
                screenStreamRef.current = null;
            }
            setScreenSharing(false);
            setScreenStream(null);
            // Revert to camera on all peers
            pcsRef.current.forEach((pc) => {
                const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
                const videoTrack = localStreamRef.current?.getVideoTracks()[0];
                if (videoSender && videoTrack) videoSender.replaceTrack(videoTrack).catch(() => { });
            });
        } else {
            try {
                const ss = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
                screenStreamRef.current = ss;
                setScreenStream(ss);
                setScreenSharing(true);
                const screenTrack = ss.getVideoTracks()[0];
                // Replace video track on all peers
                pcsRef.current.forEach((pc) => {
                    const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
                    if (videoSender) videoSender.replaceTrack(screenTrack).catch(() => { });
                });
                screenTrack.onended = () => toggleScreenShare();
            } catch { /* user cancelled */ }
        }
    }, [screenSharing]);

    const raiseHand = useCallback(() => {
        const next = !raisedHand;
        setRaisedHand(next);
        ws?.send(JSON.stringify({ type: 'meeting_raise_hand', meetingId, raised: next }));
    }, [raisedHand, meetingId, ws]);

    const sendChatMessage = useCallback((text) => {
        if (!text.trim()) return;
        ws?.send(JSON.stringify({ type: 'meeting_chat', meetingId, text: text.trim() }));
    }, [meetingId, ws]);

    const endMeeting = useCallback(() => {
        ws?.send(JSON.stringify({ type: 'meeting_end', meetingId }));
        setStatus('ended');
    }, [meetingId, ws]);

    const leaveMeeting = useCallback(() => {
        ws?.send(JSON.stringify({ type: 'meeting_leave', meetingId }));
        setStatus('ended');
    }, [meetingId, ws]);

    const muteParticipant = useCallback((userId) => {
        ws?.send(JSON.stringify({ type: 'meeting_mute_participant', meetingId, targetUserId: userId }));
    }, [meetingId, ws]);

    const addParticipant = useCallback((userId) => {
        ws?.send(JSON.stringify({ type: 'meeting_add_participant', meetingId, targetUserId: userId }));
    }, [meetingId, ws]);

    return {
        // State
        localStream, screenStream, muted, videoOff, screenSharing,
        participants, status, raisedHand, messages,
        activePanel, setActivePanel,
        connectionQualities,
        // Actions
        toggleMute, toggleVideo, toggleScreenShare, raiseHand,
        sendChatMessage, endMeeting, leaveMeeting, muteParticipant, addParticipant,
        // WS message handler (MeetingRoom passes incoming WS msgs here)
        handleWsMessage,
    };
}
