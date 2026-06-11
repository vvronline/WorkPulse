import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import {
  mediaDevices,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  RTCView,
  type MediaStream,
} from "react-native-webrtc";
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Video as VideoIcon,
  VideoOff,
  SwitchCamera,
} from "lucide-react-native";
import { theme } from "../../src/theme";
import { socket } from "../../src/realtime/socket";
import { getIceConfig } from "../../src/features";

const FALLBACK_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

type CallStatus =
  | "ringing"
  | "connecting"
  | "connected"
  | "ended"
  | "rejected";

/**
 * Native audio/video call screen (react-native-webrtc). Mirrors the web call
 * flow & WebRTC signaling protocol exactly:
 *   caller: call_initiate → call_started(callId) → call_accepted(peer) → offer
 *   callee: call_incoming → call_accept → wait for offer → answer
 *   both:   call_signal {offer|answer|ice-candidate} ; call_end / call_ended
 *
 * Route params:
 *   conversationId  (required)
 *   mode            "outgoing" | "incoming"
 *   callType        "voice" | "video"
 *   callId          (incoming only — provided by call_incoming)
 *   peerId          (incoming only — the caller's user id)
 *   peerName        display name
 */
export default function CallScreen() {
  const params = useLocalSearchParams<{
    conversationId: string;
    mode?: string;
    callType?: string;
    callId?: string;
    peerId?: string;
    peerName?: string;
  }>();
  const router = useRouter();

  const conversationId = Number(params.conversationId);
  const mode = params.mode === "incoming" ? "incoming" : "outgoing";
  const callType = params.callType === "video" ? "video" : "voice";
  const peerName = params.peerName || "Call";

  const [status, setStatus] = useState<CallStatus>(
    mode === "incoming" ? "ringing" : "ringing",
  );
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(callType !== "video");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callIdRef = useRef<number | null>(
    params.callId ? Number(params.callId) : null,
  );
  const peerIdRef = useRef<number | null>(
    params.peerId ? Number(params.peerId) : null,
  );
  const iceServersRef = useRef<any[]>(FALLBACK_ICE);
  const pendingIce = useRef<any[]>([]);
  const startedAt = useRef<number>(0);

  const endAndLeave = useCallback(
    (sendEnd: boolean) => {
      if (sendEnd && callIdRef.current) {
        socket.send("call_end", {
          callId: callIdRef.current,
          conversationId,
        });
      }
      try {
        localStreamRef.current?.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      try {
        pcRef.current?.close();
      } catch {
        /* ignore */
      }
      pcRef.current = null;
      localStreamRef.current = null;
      router.back();
    },
    [conversationId, router],
  );

  const getMedia = useCallback(async (): Promise<MediaStream | null> => {
    try {
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: callType === "video" ? { facingMode: "user" } : false,
      });
      localStreamRef.current = stream as MediaStream;
      setLocalStream(stream as MediaStream);
      return stream as MediaStream;
    } catch {
      return null;
    }
  }, [callType]);

  const createPC = useCallback(
    (stream: MediaStream, targetUserId: number) => {
      const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
      pcRef.current = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      (pc as any).onicecandidate = (e: any) => {
        if (e.candidate) {
          socket.send("call_signal", {
            conversationId,
            targetUserId,
            signal: { type: "ice-candidate", candidate: e.candidate.toJSON() },
          });
        }
      };

      (pc as any).ontrack = (e: any) => {
        if (e.streams && e.streams[0]) {
          setRemoteStream(e.streams[0]);
        }
      };

      (pc as any).onconnectionstatechange = () => {
        const st = (pc as any).connectionState;
        if (st === "connected") {
          startedAt.current = Date.now();
          setStatus("connected");
        } else if (st === "failed" || st === "closed") {
          endAndLeave(false);
        }
      };

      return pc;
    },
    [conversationId, endAndLeave],
  );

  const flushIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !(pc as any).remoteDescription) return;
    const list = pendingIce.current.splice(0);
    for (const c of list) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        /* ignore */
      }
    }
  }, []);

  // Load ICE config up front.
  useEffect(() => {
    getIceConfig()
      .then((r) => {
        if (r.data?.iceServers?.length) iceServersRef.current = r.data.iceServers;
      })
      .catch(() => {});
  }, []);

  // Outgoing: acquire media + send call_initiate immediately.
  useEffect(() => {
    if (mode !== "outgoing") return;
    (async () => {
      const stream = await getMedia();
      if (!stream) {
        endAndLeave(false);
        return;
      }
      socket.send("call_initiate", { conversationId, callType });
    })();
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [mode, conversationId, callType, getMedia, endAndLeave]);

  // Signaling listener.
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      const d = msg.data || {};
      switch (msg.type) {
        case "call_started":
          callIdRef.current = d.callId;
          break;
        case "call_accepted": {
          // Caller side: peer accepted → create offer to them.
          if (mode !== "outgoing") return;
          peerIdRef.current = d.userId;
          setStatus("connecting");
          (async () => {
            const stream = localStreamRef.current || (await getMedia());
            if (!stream) return endAndLeave(false);
            const pc = createPC(stream, d.userId);
            const offer = await pc.createOffer({});
            await pc.setLocalDescription(offer);
            socket.send("call_signal", {
              conversationId,
              targetUserId: d.userId,
              signal: { type: "offer", sdp: offer.sdp },
            });
          })();
          break;
        }
        case "call_signal": {
          if (Number(d.conversationId) !== conversationId) return;
          const signal = d.signal;
          const from = d.fromUserId;
          (async () => {
            let pc = pcRef.current;
            if (signal.type === "offer") {
              // Callee side: build PC, set remote, answer.
              const stream = localStreamRef.current || (await getMedia());
              if (!stream) return endAndLeave(false);
              pc = pcRef.current || createPC(stream, from);
              await pc.setRemoteDescription(
                new RTCSessionDescription(signal),
              );
              await flushIce();
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              socket.send("call_signal", {
                conversationId,
                targetUserId: from,
                signal: { type: "answer", sdp: answer.sdp },
              });
            } else if (signal.type === "answer") {
              if (!pc) return;
              await pc.setRemoteDescription(
                new RTCSessionDescription(signal),
              );
              await flushIce();
            } else if (signal.type === "ice-candidate") {
              if (signal.candidate == null) return;
              if (pc && (pc as any).remoteDescription) {
                try {
                  await pc.addIceCandidate(
                    new RTCIceCandidate(signal.candidate),
                  );
                } catch {
                  /* ignore */
                }
              } else {
                pendingIce.current.push(signal.candidate);
              }
            }
          })();
          break;
        }
        case "call_ended":
          if (Number(d.conversationId) === conversationId) {
            setStatus("ended");
            endAndLeave(false);
          }
          break;
        case "call_rejected":
          if (Number(d.conversationId) === conversationId) {
            setStatus("rejected");
            setTimeout(() => endAndLeave(false), 800);
          }
          break;
      }
    });
    return off;
  }, [
    mode,
    conversationId,
    getMedia,
    createPC,
    flushIce,
    endAndLeave,
  ]);

  // Incoming: accept handler.
  async function acceptIncoming() {
    setStatus("connecting");
    const stream = await getMedia();
    if (!stream) return endAndLeave(false);
    socket.send("call_accept", {
      callId: callIdRef.current,
      conversationId,
    });
    // The caller will now send us an offer (handled in call_signal).
  }

  function rejectIncoming() {
    socket.send("call_reject", {
      callId: callIdRef.current,
      conversationId,
    });
    endAndLeave(false);
  }

  function toggleMute() {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setMuted(next);
  }

  function toggleVideo() {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !videoOff;
    stream.getVideoTracks().forEach((t) => {
      t.enabled = !next;
    });
    setVideoOff(next);
  }

  function switchCamera() {
    const stream = localStreamRef.current;
    stream?.getVideoTracks().forEach((t) => {
      // react-native-webrtc track exposes _switchCamera()
      (t as any)._switchCamera?.();
    });
  }

  const statusLabel =
    status === "ringing"
      ? mode === "incoming"
        ? "Incoming call…"
        : "Ringing…"
      : status === "connecting"
        ? "Connecting…"
        : status === "connected"
          ? "Connected"
          : status === "rejected"
            ? "Call declined"
            : "Call ended";

  const showVideo = callType === "video";

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Remote video / avatar */}
      {showVideo && remoteStream ? (
        <RTCView
          streamURL={(remoteStream as any).toURL()}
          style={styles.remoteVideo}
          objectFit="cover"
        />
      ) : (
        <View style={styles.avatarWrap}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(peerName || "?")[0]?.toUpperCase()}
            </Text>
          </View>
        </View>
      )}

      {/* Local preview */}
      {showVideo && localStream && !videoOff ? (
        <RTCView
          streamURL={(localStream as any).toURL()}
          style={styles.localVideo}
          objectFit="cover"
          mirror
        />
      ) : null}

      {/* Header info */}
      <View style={styles.info}>
        <Text style={styles.peerName}>{peerName}</Text>
        <Text style={styles.status}>{statusLabel}</Text>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        {mode === "incoming" && status === "ringing" ? (
          <>
            <Pressable
              style={[styles.ctrl, styles.reject]}
              onPress={rejectIncoming}
            >
              <PhoneOff size={26} color="#fff" />
            </Pressable>
            <Pressable
              style={[styles.ctrl, styles.accept]}
              onPress={acceptIncoming}
            >
              <Phone size={26} color="#fff" />
            </Pressable>
          </>
        ) : (
          <>
            <Pressable style={styles.ctrl} onPress={toggleMute}>
              {muted ? (
                <MicOff size={24} color="#fff" />
              ) : (
                <Mic size={24} color="#fff" />
              )}
            </Pressable>
            {showVideo ? (
              <Pressable style={styles.ctrl} onPress={toggleVideo}>
                {videoOff ? (
                  <VideoOff size={24} color="#fff" />
                ) : (
                  <VideoIcon size={24} color="#fff" />
                )}
              </Pressable>
            ) : null}
            {showVideo ? (
              <Pressable style={styles.ctrl} onPress={switchCamera}>
                <SwitchCamera size={24} color="#fff" />
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.ctrl, styles.reject]}
              onPress={() => endAndLeave(true)}
            >
              <PhoneOff size={26} color="#fff" />
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0a0a0a" },
  remoteVideo: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000",
  },
  localVideo: {
    position: "absolute",
    top: 50,
    right: 16,
    width: 110,
    height: 160,
    borderRadius: 12,
    backgroundColor: "#000",
    zIndex: 5,
  },
  avatarWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  avatar: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 44, fontWeight: "700" },
  info: {
    position: "absolute",
    top: 80,
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 6,
  },
  peerName: { color: "#fff", fontSize: 24, fontWeight: "700" },
  status: { color: "rgba(255,255,255,0.7)", fontSize: 15 },
  controls: {
    position: "absolute",
    bottom: 48,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 20,
  },
  ctrl: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  reject: { backgroundColor: theme.danger },
  accept: { backgroundColor: theme.success },
});