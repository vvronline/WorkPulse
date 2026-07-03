import {
  useEffect,
  useMemo,
  useRef,
  useState } from "react";
import { ActivityIndicator,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { RTCView } from "react-native-webrtc";
import {
  Check,
  Copy,
  Hand,
  Mic,
  MicOff,
  Minimize2,
  MessageSquare,
  MoreVertical,
  PhoneOff,
  RefreshCw,
  SmilePlus,
  SwitchCamera,
  UserPlus,
  Users,
  Video as VideoIcon,
  VideoOff,
  X,
  Circle,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useAuth } from "../../src/auth/AuthContext";
import { getMeeting, searchChatUsers } from "../../src/features";
import { SERVER_ORIGIN } from "../../src/config";
import { socket } from "../../src/realtime/socket";
import {
  useMeetingMesh,
  type MeetingParticipant,
} from "../../src/meeting/useMeetingMesh";
import { makeStyles } from "./[code].styles";

// Resolve an avatar path returned by the API (which may be relative, e.g.
// "/uploads/avatars/x.png") to an absolute URL the <Image> can load. Mirrors
// the web ParticipantTile's avatar URL resolution.
function resolveAvatarUrl(avatar?: string | null): string | null {
  if (!avatar) return null;
  if (avatar.startsWith("http")) return avatar;
  return `${SERVER_ORIGIN}${avatar.startsWith("/") ? "" : "/"}${avatar}`;
}

/**
 * In-app meeting room. Joins the SAME WebRTC mesh as the web/desktop clients
 * (server/utils/ws.ts relays the signaling) instead of bouncing the user to a
 * browser. The layout mirrors the web client's mobile meeting view
 * (client/src/pages/MeetingRoom.tsx + MeetingRoom.css): a header with the
 * title / copyable code / elapsed timer, an adaptive participant grid with
 * name + mute + connecting overlays, and a bottom control bar.
 */
export default function MeetingScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user } = useAuth();
  const { code, huddle, callType } = useLocalSearchParams<{
    code: string;
    huddle?: string;
    callType?: string;
  }>();

  // Group CALL (huddle) mode: when entered from an incoming-call ring / start
  // group call, we skip the meeting lobby entirely and auto-join the mesh —
  // and for a VOICE call we join audio-only (camera off) so a voice call never
  // lights up the camera. This decouples the group CALL UX from the meeting UX
  // (Slack-huddle / Teams-call parity).
  const isHuddle = huddle === "1" || huddle === "true";
  const huddleVideoOff = isHuddle && callType !== "video";

  const [meetingId, setMeetingId] = useState<number | null>(null);
  const [title, setTitle] = useState("Meeting");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // True when the current user created the meeting → expose host-only controls
  // (End meeting for all), mirroring the web MeetingBottomBar.
  const [isHost, setIsHost] = useState(false);
  // Local raised-hand state + the set of remote userIds with a raised hand
  // (driven by the server `meeting_hand_raised` broadcast). Mirrors web.
  const [raisedHand, setRaisedHand] = useState(false);
  const [raisedHands, setRaisedHands] = useState<Set<string>>(new Set());
  const [showMore, setShowMore] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [recording, setRecording] = useState(false);
  // Add-participant (Signal-style "add to call"). Any joined member of a
  // huddle can pull in another tenant user; the server rings them natively.
  const [showAddPeople, setShowAddPeople] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [addSearching, setAddSearching] = useState(false);
  const [addResults, setAddResults] = useState<
    Array<{ id: number | string; full_name?: string; username?: string }>
  >([]);
  const addTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // userIds we invited that haven't joined yet → "Ringing…" rows.
  const [pendingInvites, setPendingInvites] = useState<
    Map<string, { name: string; declined?: boolean }>
  >(new Map());
  const [showChat, setShowChat] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [chatText, setChatText] = useState("");
  const [chatUnread, setChatUnread] = useState(0);
  const [meetingMessages, setMeetingMessages] = useState<
    Array<{
      id: string | number;
      senderId?: number;
      senderName?: string;
      content?: string;
      createdAt?: string;
    }>
  >([]);

  // Resolve the meeting by code (mirrors the web auto-join path).
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    getMeeting(code)
      .then((r) => {
        if (cancelled) return;
        setMeetingId(r.data.id);
        if (r.data.title) setTitle(r.data.title);
        if (r.data.created_by != null && user?.id != null) {
          setIsHost(Number(r.data.created_by) === Number(user.id));
        }
      })
      .catch(() => {
        if (!cancelled)
          setLoadError("Meeting not found or you are not invited.");
      });
    return () => {
      cancelled = true;
    };
  }, [code, user?.id]);

  const {
    localStream,
    participants,
    muted,
    videoOff,
    usingFrontCamera,
    status,
    mediaError,
    toggleMute,
    toggleVideo,
    switchCamera,
    join,
    leave,
    retryPeer,
  } = useMeetingMesh({
    meetingId,
    selfId: user?.id ?? null,
    initialMuted: false,
    initialVideoOff: huddleVideoOff,
    // Huddles auto-join (no pre-join lobby); regular meetings show the lobby.
    autoJoin: isHuddle,
  });

  // Listen for raised-hand broadcasts so we can show the hand badge on tiles
  // and in the participants list (server `meeting_hand_raised`).
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      const d: any = msg.data || {};
      if (msg.type === "meeting_hand_raised") {
        if (d.userId == null) return;
        const key = String(d.userId);
        setRaisedHands((prev) => {
          const next = new Set(prev);
          if (d.raised) next.add(key);
          else next.delete(key);
          return next;
        });
        if (user?.id != null && Number(d.userId) === Number(user.id)) {
          setRaisedHand(!!d.raised);
        }
        return;
      }
      if (msg.type === "huddle_declined") {
        // An invited member declined the group-call ring — drop/mark their
        // pending "Ringing…" row.
        if (Number(d.meetingId) !== Number(meetingId)) return;
        const key = String(d.userId);
        setPendingInvites((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.set(key, { ...next.get(key)!, declined: true });
          return next;
        });
        return;
      }
      if (msg.type === "meeting_participant_joined") {
        // An invited member answered — clear their pending row.
        if (Number(d.meetingId) !== Number(meetingId)) return;
        const key = String(d.userId);
        setPendingInvites((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        return;
      }
      if (msg.type === "meeting_message") {
        if (Number(d.meetingId) !== Number(meetingId)) return;
        const m = d.message || {};
        const msgId = m.id ?? m.clientMsgId ?? `${Date.now()}-${Math.random()}`;
        setMeetingMessages((prev) => {
          if (prev.some((x) => String(x.id) === String(msgId))) return prev;
          return [
            ...prev,
            {
              id: msgId,
              senderId: m.senderId,
              senderName: m.senderName,
              content: m.content,
              createdAt: m.createdAt,
            },
          ];
        });
        if (Number(m.senderId) !== Number(user?.id) && !showChat) {
          setChatUnread((c) => c + 1);
        }
      }
    });
    return off;
  }, [meetingId, showChat, user?.id]);

  const inviteUser = (u: {
    id: number | string;
    full_name?: string;
    username?: string;
  }) => {
    if (!meetingId) return;
    socket.send("meeting_add_participant", {
      meetingId,
      targetUserId: Number(u.id),
    });
    setPendingInvites((prev) => {
      const next = new Map(prev);
      next.set(String(u.id), { name: u.full_name || u.username || "User" });
      return next;
    });
    setShowAddPeople(false);
    setAddQuery("");
    setAddResults([]);
  };

  const sendMeetingChat = () => {
    const content = chatText.trim();
    if (!content || !meetingId) return;
    socket.send("meeting_chat", {
      meetingId,
      content,
      clientMsgId: `mobile-${Date.now()}`,
    });
    setChatText("");
  };

  const sendReaction = (emoji: string) => {
    if (!meetingId) return;
    socket.send("meeting_chat", {
      meetingId,
      content: emoji,
      clientMsgId: `mobile-r-${Date.now()}`,
    });
    setShowReactions(false);
    setShowMore(false);
  };

  const toggleRaiseHand = () => {
    const next = !raisedHand;
    setRaisedHand(next);
    socket.send("meeting_raise_hand", { meetingId, raised: next });
  };

  const endMeeting = () => {
    socket.send("meeting_end", { meetingId });
    leave();
    router.back();
  };

  // Elapsed timer — starts ticking once we're connected.
  useEffect(() => {
    if (status !== "connected") return;
    const startedAt = Date.now();
    setElapsed(0);
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, [status]);

  // Leave the meeting (or bounce back) when the host ends it.
  useEffect(() => {
    if (status === "ended") {
      leave();
      router.back();
    }
  }, [status, leave, router]);

  const handleLeave = () => {
    leave();
    router.back();
  };

  async function copyCode() {
    if (!code) return;
    try {
      await Clipboard.setStringAsync(code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  async function openInBrowser() {
    setOpening(true);
    try {
      await Linking.openURL(`${SERVER_ORIGIN}/meeting/${code}`);
    } finally {
      setOpening(false);
    }
  }

  // ── Error / fallback states ──────────────────────────────────────────────
  if (loadError || mediaError) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: "Meeting" }} />
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <VideoIcon size={32} color={theme.primary} />
          </View>
          <Text style={styles.cardTitle}>Can't join the meeting</Text>
          <Text style={styles.hint}>{loadError || mediaError}</Text>
          {!loadError ? (
            <Pressable
              style={styles.fallbackBtn}
              onPress={openInBrowser}
              disabled={opening}
            >
              {opening ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <VideoIcon size={16} color="#fff" />
                  <Text style={styles.fallbackBtnText}>Open in browser</Text>
                </>
              )}
            </Pressable>
          ) : null}
          <Pressable style={styles.linkBtn} onPress={() => router.back()}>
            <Text style={styles.linkBtnText}>Go back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Pre-join lobby ───────────────────────────────────────────────────────
  // Mobile-appropriate equivalent of the web device-selection screen: a live
  // self-preview plus mic / camera / flip controls. The user confirms their
  // setup here, then "Join now" fires the actual `meeting_join`.
  if (status === "lobby") {
    return (
      <LobbyScreen
        theme={theme}
        title={title}
        code={code}
        codeCopied={codeCopied}
        copyCode={copyCode}
        localStream={localStream}
        usingFrontCamera={usingFrontCamera}
        muted={muted}
        videoOff={videoOff}
        toggleMute={toggleMute}
        toggleVideo={toggleVideo}
        switchCamera={switchCamera}
        onJoin={join}
        onCancel={() => router.back()}
      />
    );
  }

  const remoteParticipants = Array.from(participants.values());
  const connecting = status === "joining" || status === "connecting";
  // Tile count = self + remote participants. Drives the adaptive grid columns.
  const tileCount = remoteParticipants.length + 1;
  // A huddle is a CALL, not a meeting — never show meeting-flavoured copy
  // ("Joining…"). While nobody has answered yet the call is "Ringing…".
  const statusText =
    status === "connected"
      ? `${tileCount} in call`
      : isHuddle
        ? remoteParticipants.length === 0
          ? "Ringing…"
          : "Connecting…"
        : status === "connecting"
          ? "Connecting…"
          : "Joining…";

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header — huddles hide the meeting-code pill (a group CALL has no
          user-facing meeting artifacts). */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          {!isHuddle ? (
            <Pressable style={styles.codePill} onPress={copyCode}>
              <Text style={styles.codeText}>{code}</Text>
              {codeCopied ? (
                <Check size={12} color={theme.success} />
              ) : (
                <Copy size={12} color={theme.textMuted} />
              )}
            </Pressable>
          ) : null}
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.headerStatus}>
            {status === "connected" ? formatTime(elapsed) : statusText}
          </Text>
          <Pressable style={styles.headerBtn} onPress={() => router.back()}>
            <Minimize2 size={16} color={theme.text} />
          </Pressable>
        </View>
      </View>

      {/* Video grid */}
      <ScrollView
        style={styles.gridScroll}
        contentContainerStyle={styles.grid}
      >
        {/* Self tile — mirror ONLY when using the front camera, otherwise the
            rear feed renders left-right flipped. */}
        <VideoTile
          theme={theme}
          tileCount={tileCount}
          name={user?.full_name || user?.username || "You"}
          avatar={user?.avatar}
          isLocal
          stream={localStream}
          videoOff={videoOff}
          muted={muted}
          connected
          mirror={usingFrontCamera}
          raisedHand={raisedHand}
        />
        {remoteParticipants.map((p) => (
          <RemoteTile
            key={String(p.userId)}
            theme={theme}
            tileCount={tileCount}
            participant={p}
            raisedHand={raisedHands.has(String(p.userId))}
            onRetry={() => retryPeer(p.userId)}
          />
        ))}
      </ScrollView>

      {(connecting || status === "connected") &&
      remoteParticipants.length === 0 ? (
        <View style={styles.waiting} pointerEvents="none">
          <ActivityIndicator color={theme.primary} />
          <Text style={styles.waitingText}>
            {isHuddle ? "Ringing…" : "Waiting for others to join…"}
          </Text>
        </View>
      ) : null}

      {/* Bottom control bar */}
      <View style={styles.controls}>
        <ControlButton
          theme={theme}
          active={muted}
          label={muted ? "Unmute" : "Mute"}
          onPress={toggleMute}
          icon={
            muted ? (
              <MicOff size={22} color="#fff" />
            ) : (
              <Mic size={22} color="#fff" />
            )
          }
        />
        <ControlButton
          theme={theme}
          active={videoOff}
          label={videoOff ? "Start" : "Stop"}
          onPress={toggleVideo}
          icon={
            videoOff ? (
              <VideoOff size={22} color="#fff" />
            ) : (
              <VideoIcon size={22} color="#fff" />
            )
          }
        />
        <ControlButton
          theme={theme}
          label="Flip"
          onPress={switchCamera}
          icon={<SwitchCamera size={22} color="#fff" />}
        />
        <ControlButton
          theme={theme}
          active={raisedHand}
          label="Hand"
          onPress={toggleRaiseHand}
          icon={<Hand size={22} color="#fff" />}
        />
        <ControlButton
          theme={theme}
          active={showChat}
          label="Chat"
          onPress={() => {
            setShowChat((v) => !v);
            setChatUnread(0);
          }}
          icon={
            <View>
              <MessageSquare size={22} color="#fff" />
              {chatUnread > 0 && !showChat ? (
                <View style={styles.ctrlUnreadDot}>
                  <Text style={styles.ctrlUnreadText}>
                    {chatUnread > 9 ? "9+" : chatUnread}
                  </Text>
                </View>
              ) : null}
            </View>
          }
        />
        <ControlButton
          theme={theme}
          label="More"
          onPress={() => setShowMore(true)}
          icon={<MoreVertical size={22} color="#fff" />}
        />
        <ControlButton
          theme={theme}
          danger
          label={isHuddle ? "End" : "Leave"}
          onPress={handleLeave}
          icon={<PhoneOff size={24} color="#fff" />}
        />
      </View>

      {/* "More" actions drawer (mirrors the web MeetingBottomBar mobile
          drawer): Participants list + host End-for-all. */}
      <Modal
        visible={showMore}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMore(false)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setShowMore(false)}
        >
          <Pressable style={styles.sheet}>
            <Pressable
              style={styles.sheetItem}
              onPress={() => {
                setShowMore(false);
                setShowParticipants(true);
              }}
            >
              <Users size={18} color={theme.text} />
              <Text style={styles.sheetItemText}>
                Participants ({tileCount})
              </Text>
            </Pressable>
            <Pressable
              style={styles.sheetItem}
              onPress={() => {
                setShowMore(false);
                setShowAddPeople(true);
              }}
            >
              <UserPlus size={18} color={theme.text} />
              <Text style={styles.sheetItemText}>Add people</Text>
            </Pressable>
            <Pressable
              style={styles.sheetItem}
              onPress={() => {
                setShowMore(false);
                setShowChat(true);
                setChatUnread(0);
              }}
            >
              <MessageSquare size={18} color={theme.text} />
              <Text style={styles.sheetItemText}>Chat</Text>
            </Pressable>
            <Pressable
              style={styles.sheetItem}
              onPress={() => {
                setShowMore(false);
                setShowReactions(true);
              }}
            >
              <SmilePlus size={18} color={theme.text} />
              <Text style={styles.sheetItemText}>Send reaction</Text>
            </Pressable>
            <Pressable
              style={styles.sheetItem}
              onPress={() => {
                setRecording((v) => !v);
                setShowMore(false);
              }}
            >
              <Circle
                size={18}
                color={recording ? theme.danger : theme.text}
                fill={recording ? theme.danger : "none"}
              />
              <Text
                style={[
                  styles.sheetItemText,
                  recording ? { color: theme.danger } : null,
                ]}
              >
                {recording ? "Stop recording" : "Record meeting"}
              </Text>
            </Pressable>
            {isHost ? (
              <Pressable
                style={styles.sheetItem}
                onPress={() => {
                  setShowMore(false);
                  endMeeting();
                }}
              >
                <PhoneOff size={18} color={theme.danger} />
                <Text style={[styles.sheetItemText, { color: theme.danger }]}>
                  End meeting for all
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              style={styles.sheetCancel}
              onPress={() => setShowMore(false)}
            >
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={showReactions}
        transparent
        animationType="fade"
        onRequestClose={() => setShowReactions(false)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setShowReactions(false)}
        >
          <Pressable style={styles.reactionSheet}>
            {["👍", "👏", "❤️", "😂", "🎉", "🤔"].map((emoji) => (
              <Pressable
                key={emoji}
                style={styles.reactionBtn}
                onPress={() => sendReaction(emoji)}
              >
                <Text style={styles.reactionText}>{emoji}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={showChat}
        transparent
        animationType="slide"
        onRequestClose={() => setShowChat(false)}
      >
        <View style={styles.chatPanel}>
          <View style={styles.chatHeader}>
            <Text style={styles.chatTitle}>Meeting chat</Text>
            <Pressable onPress={() => setShowChat(false)}>
              <Text style={styles.chatClose}>Close</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.chatBody}>
            {meetingMessages.map((m) => {
              const mine = Number(m.senderId) === Number(user?.id);
              return (
                <View
                  key={String(m.id)}
                  style={[styles.chatMsg, mine ? styles.chatMsgMine : styles.chatMsgPeer]}
                >
                  <Text style={styles.chatMsgSender}>
                    {mine ? "You" : m.senderName || "Participant"}
                  </Text>
                  <Text style={styles.chatMsgText}>{m.content || ""}</Text>
                </View>
              );
            })}
          </ScrollView>
          <View style={styles.chatComposer}>
            <TextInput
              style={styles.chatInput}
              value={chatText}
              onChangeText={setChatText}
              placeholder="Type a message"
              placeholderTextColor={theme.textMuted}
            />
            <Pressable style={styles.chatSendBtn} onPress={sendMeetingChat}>
              <Text style={styles.chatSendText}>Send</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Add-people modal — search tenant users and ring them into the call.
          The server handles the native ring (`call_incoming` for huddles /
          `meeting_invite` for meetings). */}
      <Modal
        visible={showAddPeople}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAddPeople(false)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setShowAddPeople(false)}
        >
          <Pressable style={styles.participantsPanel}>
            <View style={styles.participantsHeader}>
              <Text style={styles.participantsTitle}>Add people</Text>
              <Pressable onPress={() => setShowAddPeople(false)}>
                <X size={20} color={theme.text} />
              </Pressable>
            </View>
            <View
              style={{
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 6,
                marginBottom: 10,
              }}
            >
              <TextInput
                value={addQuery}
                onChangeText={(val) => {
                  setAddQuery(val);
                  if (addTimerRef.current) clearTimeout(addTimerRef.current);
                  if (val.trim().length < 2) {
                    setAddResults([]);
                    setAddSearching(false);
                    return;
                  }
                  addTimerRef.current = setTimeout(async () => {
                    setAddSearching(true);
                    try {
                      const r = await searchChatUsers(val.trim());
                      const selfId = Number(user?.id || 0);
                      const inCall = new Set(
                        remoteParticipants.map((p) => Number(p.userId)),
                      );
                      const rows = (r.data || []).filter((u: any) => {
                        const uid = Number(u.id);
                        return uid > 0 && uid !== selfId && !inCall.has(uid);
                      });
                      setAddResults(rows);
                    } catch {
                      setAddResults([]);
                    } finally {
                      setAddSearching(false);
                    }
                  }, 300);
                }}
                placeholder="Search people…"
                placeholderTextColor={theme.textMuted}
                style={{ color: theme.text, fontSize: 15 }}
                autoFocus
              />
            </View>
            {addSearching ? (
              <View style={{ paddingVertical: 14, alignItems: "center" }}>
                <ActivityIndicator color={theme.primary} />
              </View>
            ) : null}
            <ScrollView keyboardShouldPersistTaps="handled">
              {addResults.map((u) => (
                <Pressable
                  key={String(u.id)}
                  style={{
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: theme.border,
                  }}
                  onPress={() => inviteUser(u)}
                >
                  <Text
                    style={{ color: theme.text, fontSize: 15 }}
                    numberOfLines={1}
                  >
                    {u.full_name || u.username || "User"}
                  </Text>
                  {u.username ? (
                    <Text style={{ color: theme.textMuted, fontSize: 12 }}>
                      @{u.username}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
              {!addSearching &&
              addQuery.trim().length >= 2 &&
              addResults.length === 0 ? (
                <Text
                  style={{
                    color: theme.textMuted,
                    textAlign: "center",
                    paddingVertical: 16,
                  }}
                >
                  No matching users
                </Text>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Participants list modal. */}
      <Modal
        visible={showParticipants}
        transparent
        animationType="slide"
        onRequestClose={() => setShowParticipants(false)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setShowParticipants(false)}
        >
          <Pressable style={styles.participantsPanel}>
            <View style={styles.participantsHeader}>
              <Text style={styles.participantsTitle}>
                Participants ({tileCount})
              </Text>
              <Pressable onPress={() => setShowParticipants(false)}>
                <X size={20} color={theme.text} />
              </Pressable>
            </View>
            <ScrollView>
              <ParticipantRow
                theme={theme}
                name={`${user?.full_name || user?.username || "You"} (You)`}
                avatar={user?.avatar}
                muted={muted}
                raisedHand={raisedHand}
              />
              {remoteParticipants.map((p) => (
                <ParticipantRow
                  key={String(p.userId)}
                  theme={theme}
                  name={p.name}
                  avatar={p.avatar}
                  muted={p.muted}
                  raisedHand={raisedHands.has(String(p.userId))}
                />
              ))}
              {Array.from(pendingInvites.entries()).map(([uid, info]) => (
                <View key={`pending-${uid}`} style={styles.participantRow}>
                  <View style={styles.participantAvatar}>
                    <Text style={styles.participantAvatarText}>
                      {(info.name || "?")[0]?.toUpperCase()}
                    </Text>
                  </View>
                  <Text style={styles.participantName} numberOfLines={1}>
                    {info.name}
                  </Text>
                  <Text
                    style={{
                      color: info.declined ? theme.danger : theme.textMuted,
                      fontSize: 12,
                    }}
                  >
                    {info.declined ? "Declined" : "Ringing…"}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function ParticipantRow({
  theme,
  name,
  avatar,
  muted,
  raisedHand,
}: {
  theme: Theme;
  name: string;
  avatar?: string | null;
  muted?: boolean;
  raisedHand?: boolean;
}) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const avatarUrl = resolveAvatarUrl(avatar);
  return (
    <View style={styles.participantRow}>
      <View style={styles.participantAvatar}>
        {avatarUrl ? (
          <Image
            source={{ uri: avatarUrl }}
            style={styles.participantAvatarImg}
          />
        ) : (
          <Text style={styles.participantAvatarText}>
            {(name || "?")[0]?.toUpperCase()}
          </Text>
        )}
      </View>
      <Text style={styles.participantName} numberOfLines={1}>
        {name}
      </Text>
      {raisedHand ? <Hand size={16} color={theme.primary} /> : null}
      {muted ? <MicOff size={16} color={theme.textMuted} /> : null}
    </View>
  );
}

function LobbyScreen({
  theme,
  title,
  code,
  codeCopied,
  copyCode,
  localStream,
  usingFrontCamera,
  muted,
  videoOff,
  toggleMute,
  toggleVideo,
  switchCamera,
  onJoin,
  onCancel,
}: {
  theme: Theme;
  title: string;
  code?: string;
  codeCopied: boolean;
  copyCode: () => void;
  localStream: any;
  usingFrontCamera: boolean;
  muted: boolean;
  videoOff: boolean;
  toggleMute: () => void;
  toggleVideo: () => void;
  switchCamera: () => void;
  onJoin: () => void;
  onCancel: () => void;
}) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const showVideo = localStream && !videoOff;

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          {code ? (
            <Pressable style={styles.codePill} onPress={copyCode}>
              <Text style={styles.codeText}>{code}</Text>
              {codeCopied ? (
                <Check size={12} color={theme.success} />
              ) : (
                <Copy size={12} color={theme.textMuted} />
              )}
            </Pressable>
          ) : null}
        </View>
        <View style={styles.headerRight}>
          <Pressable style={styles.headerBtn} onPress={onCancel}>
            <Minimize2 size={16} color={theme.text} />
          </Pressable>
        </View>
      </View>

      {/* Self preview */}
      <View style={styles.lobbyPreviewWrap}>
        <View style={styles.lobbyPreview}>
          {showVideo ? (
            <RTCView
              streamURL={(localStream as any).toURL()}
              style={styles.lobbyVideo}
              objectFit="cover"
              mirror={usingFrontCamera}
              zOrder={0}
            />
          ) : (
            <View style={styles.lobbyAvatarWrap}>
              {!localStream ? (
                <>
                  <ActivityIndicator color={theme.primary} />
                  <Text style={styles.lobbyHint}>Starting camera…</Text>
                </>
              ) : (
                <>
                  <View style={styles.lobbyAvatar}>
                    <VideoOff size={30} color="#fff" />
                  </View>
                  <Text style={styles.lobbyHint}>Camera is off</Text>
                </>
              )}
            </View>
          )}
          {muted ? (
            <View style={styles.lobbyMuteBadge}>
              <MicOff size={13} color="#fff" />
              <Text style={styles.lobbyMuteText}>Muted</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Pre-join device controls */}
      <View style={styles.controls}>
        <ControlButton
          theme={theme}
          active={muted}
          label={muted ? "Unmute" : "Mute"}
          onPress={toggleMute}
          icon={
            muted ? (
              <MicOff size={22} color="#fff" />
            ) : (
              <Mic size={22} color="#fff" />
            )
          }
        />
        <ControlButton
          theme={theme}
          active={videoOff}
          label={videoOff ? "Start" : "Stop"}
          onPress={toggleVideo}
          icon={
            videoOff ? (
              <VideoOff size={22} color="#fff" />
            ) : (
              <VideoIcon size={22} color="#fff" />
            )
          }
        />
        <ControlButton
          theme={theme}
          label="Flip"
          onPress={switchCamera}
          icon={<SwitchCamera size={22} color="#fff" />}
        />
      </View>

      {/* Join action */}
      <View style={styles.lobbyActions}>
        <Pressable style={styles.lobbyJoinBtn} onPress={onJoin}>
          <VideoIcon size={18} color="#fff" />
          <Text style={styles.lobbyJoinText}>Join now</Text>
        </Pressable>
        <Pressable style={styles.linkBtn} onPress={onCancel}>
          <Text style={styles.linkBtnText}>Cancel</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function formatTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function ControlButton({
  theme,
  icon,
  label,
  onPress,
  active = false,
  danger = false,
}: {
  theme: Theme;
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.ctrlWrap}>
      <Pressable
        style={[
          styles.ctrl,
          active && styles.ctrlActive,
          danger && styles.ctrlDanger,
        ]}
        onPress={onPress}
      >
        {icon}
      </Pressable>
      <Text style={styles.ctrlLabel}>{label}</Text>
    </View>
  );
}

function RemoteTile({
  theme,
  participant,
  tileCount,
  raisedHand = false,
  onRetry,
}: {
  theme: Theme;
  participant: MeetingParticipant;
  tileCount: number;
  raisedHand?: boolean;
  onRetry?: () => void;
}) {
  return (
    <VideoTile
      theme={theme}
      tileCount={tileCount}
      name={participant.name}
      avatar={participant.avatar}
      stream={participant.stream}
      videoOff={participant.videoOff}
      muted={participant.muted}
      connected={!!participant.stream}
      mirror={false}
      raisedHand={raisedHand}
      connectFailed={participant.connectFailed}
      onRetry={onRetry}
    />
  );
}

function VideoTile({
  theme,
  name,
  avatar,
  stream,
  videoOff,
  muted,
  tileCount,
  isLocal = false,
  connected = false,
  mirror = false,
  raisedHand = false,
  connectFailed = false,
  onRetry,
}: {
  theme: Theme;
  name: string;
  avatar?: string | null;
  stream: any;
  videoOff: boolean;
  muted: boolean;
  tileCount: number;
  isLocal?: boolean;
  connected?: boolean;
  mirror?: boolean;
  raisedHand?: boolean;
  connectFailed?: boolean;
  onRetry?: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const avatarUrl = resolveAvatarUrl(avatar);

  // Adaptive grid sizing (mirrors web's mobile breakpoints): 1 column for a
  // 1:1 call, 2 columns otherwise. Tiles fill the available width with a
  // square-ish aspect so they don't look stretched.
  const gap = 10;
  const outer = 12;
  const cols = tileCount <= 1 ? 1 : 2;
  const tileWidth = (width - outer * 2 - gap * (cols - 1)) / cols;
  // For a single tile take most of the screen; for grids keep a 3:4 portrait.
  const tileHeight =
    tileCount <= 1
      ? Math.min(height * 0.62, tileWidth * 1.2)
      : tileWidth * 1.15;
  const showVideo = stream && !videoOff;
  // Defensive guard: only the local self-preview may be mirrored.
  const shouldMirror = isLocal && mirror;
  const videoStyle = isLocal
    ? styles.tileVideo
    : [styles.tileVideo, Platform.OS === "android" && styles.unmirrorVideo];
  const displayName = isLocal ? `${name} (You)` : name;
  // Phase 3.2 (G5) — once the 30s connect timeout flags this peer, show a
  // "Couldn't connect — Retry" state instead of the infinite spinner.
  const hasConnectFailed = !isLocal && !!connectFailed && !showVideo;
  const showConnecting = !isLocal && !connected && !hasConnectFailed;

  return (
    <View style={[styles.tile, { width: tileWidth, height: tileHeight }]}>
      {showVideo ? (
        <RTCView
          streamURL={(stream as any).toURL()}
          style={videoStyle}
          objectFit="cover"
          mirror={shouldMirror}
          zOrder={0}
        />
      ) : (
        <View style={styles.tileAvatarWrap}>
          <View style={styles.tileAvatar}>
            {avatarUrl && !avatarFailed ? (
              <Image
                source={{ uri: avatarUrl }}
                style={styles.tileAvatarImg}
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <Text style={styles.tileAvatarText}>
                {(name || "?")[0]?.toUpperCase()}
              </Text>
            )}
          </View>
          {hasConnectFailed ? (
            <View style={styles.tileStatusRow}>
              <View style={{ alignItems: "center", gap: 8 }}>
                <Text style={styles.tileFailedText}>Couldn't connect</Text>
                <Pressable style={styles.tileRetryBtn} onPress={onRetry}>
                  <RefreshCw size={13} color="#fff" />
                  <Text style={styles.tileRetryText}>Retry</Text>
                </Pressable>
              </View>
            </View>
          ) : showConnecting ? (
            <View style={styles.tileStatusRow}>
              <ActivityIndicator size="small" color={theme.textSecondary} />
              <Text style={styles.tileStatusText}>Connecting…</Text>
            </View>
          ) : null}
        </View>
      )}
      {raisedHand ? (
        <View style={styles.tileHand}>
          <Hand size={14} color="#fff" />
        </View>
      ) : null}
      <View style={styles.tileFooter}>
        {muted ? <MicOff size={12} color="#fff" /> : null}
        <Text style={styles.tileName} numberOfLines={1}>
          {displayName}
        </Text>
      </View>
    </View>
  );
}
