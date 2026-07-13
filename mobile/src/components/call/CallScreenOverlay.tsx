import type { ComponentType } from "react";
import { useRef } from "react";
import {
  useWindowDimensions,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import {
  Disc,
  MessageSquare,
  Mic,
  MicOff,
  MoreVertical,
  Pause,
  Phone,
  PhoneOff,
  Play,
  Signal,
  Smile,
  Sparkles,
  SwitchCamera,
  Video as VideoIcon,
  VideoOff,
  Volume1,
  Volume2,
} from "../../icons";

// Signal-style control glyph colours: white on the translucent (off) circle,
// near-black on the solid white (toggled/on) circle.
const CTRL_OFF = "#ffffff";
const CTRL_ON = "#1b1b1b";

type CallStatus =
  | "ringing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "rejected";

type CallMessage = {
  id: string | number;
  senderId?: number;
  senderName?: string;
  content?: string;
};

type FloatingReaction = { id: number; emoji: string; fromSelf: boolean };

type Props = {
  styles: any;
  insets: { top: number; bottom: number };
  isInPip: boolean;
  // Auto-hide: when false (and the call is connected) the peer name, duration,
  // status/quality badges and the control bar fade out. During ringing/incoming
  // they always stay visible so accept/decline/hang-up remain reachable.
  controlsVisible: boolean;
  status: CallStatus;
  mode: "incoming" | "outgoing";
  statusLabel: string;
  peerName: string;
  peerId: number | null;
  showVideo: boolean;
  callType: "voice" | "video";
  muted: boolean;
  videoOff: boolean;
  speakerOn: boolean;
  onHold: boolean;
  showChat: boolean;
  showMore: boolean;
  chatUnread: number;
  noiseSuppressionEnabled: boolean;
  recording: boolean;
  peerMuted: boolean;
  peerQuality: "good" | "fair" | "poor" | "unknown";
  qualityColor: string;
  qualityLabel: string;
  floatingReactions: FloatingReaction[];
  showReactionPicker: boolean;
  callMessages: CallMessage[];
  chatText: string;
  onChangeChatText: (value: string) => void;
  onRejectIncoming: () => void;
  onAcceptIncoming: () => void;
  onToggleMute: () => void;
  onToggleVideo: () => void;
  onSwitchCamera: () => void;
  onToggleSpeaker: () => void;
  onToggleHold: () => void;
  onOpenMore: () => void;
  onCloseMore: () => void;
  onToggleChat: () => void;
  onOpenChat: () => void;
  onCloseChat: () => void;
  onOpenReactionPicker: () => void;
  onCloseReactionPicker: () => void;
  isGroupCall: boolean;
  onAddParticipant: () => void;
  onToggleNoiseSuppression: () => void;
  onToggleRecording: () => void;
  onSendReaction: (emoji: string) => void;
  onSendChat: () => void;
  onEndCall: () => void;
  CallDurationComponent: ComponentType<{ active: boolean; style: any }>;
};

export default function CallScreenOverlay({
  styles,
  insets,
  isInPip,
  controlsVisible,
  status,
  mode,
  statusLabel,
  peerName,
  peerId,
  showVideo,
  callType,
  muted,
  videoOff,
  speakerOn,
  onHold,
  showChat,
  showMore,
  chatUnread,
  noiseSuppressionEnabled,
  recording,
  peerMuted,
  peerQuality,
  qualityColor,
  qualityLabel,
  floatingReactions,
  showReactionPicker,
  callMessages,
  chatText,
  onChangeChatText,
  onRejectIncoming,
  onAcceptIncoming,
  onToggleMute,
  onToggleVideo,
  onSwitchCamera,
  onToggleSpeaker,
  onToggleHold,
  onOpenMore,
  onCloseMore,
  onToggleChat,
  onOpenChat,
  onCloseChat,
  onOpenReactionPicker,
  onCloseReactionPicker,
  isGroupCall,
  onAddParticipant,
  onToggleNoiseSuppression,
  onToggleRecording,
  onSendReaction,
  onSendChat,
  onEndCall,
  CallDurationComponent,
}: Props) {
  // Keep the Signal-style control row from overflowing on narrow devices: the
  // video row can show up to six 58px circles, so shrink them a touch when the
  // screen is small.
  const { width: screenWidth } = useWindowDimensions();
  const chatScrollRef = useRef<ScrollView>(null);
  const compactControls = screenWidth < 380;
  const ctrlDim = compactControls ? 50 : 58;
  const ctrlIcon = compactControls ? 22 : 24;
  const ctrlSizeStyle = {
    width: ctrlDim,
    height: ctrlDim,
    borderRadius: ctrlDim / 2,
  };

  // When the call is connected and the idle timer has elapsed, hide the call
  // chrome (top badges, peer name + duration, control bar). The accept/decline
  // incoming controls are NOT gated on this — they only show while ringing.
  const hideChrome = status === "connected" && !controlsVisible;

  return (
    <>
      {/* Readability scrims. The video-off fallback background follows the
          device's light/dark scheme, so the white call name + controls need a
          subtle dark fade behind them to stay legible on a light background
          (and over bright video). Hidden in PiP. */}
      {!isInPip ? (
        <>
          <LinearGradient
            colors={["rgba(0,0,0,0.45)", "transparent"] as const}
            style={styles.topScrim}
            pointerEvents="none"
          />
          <LinearGradient
            colors={["transparent", "rgba(0,0,0,0.5)"] as const}
            style={styles.bottomScrim}
            pointerEvents="none"
          />
        </>
      ) : null}

      {!isInPip && status === "connected" && !hideChrome ? (
        <View style={[styles.topBar, { top: insets.top + 8 }]}>
          <View style={styles.qualityBadge}>
            <Signal size={13} color={qualityColor} />
            <Text style={[styles.qualityLabel, { color: qualityColor }]}>
              {qualityLabel}
            </Text>
          </View>
          <View style={styles.statusBadgeRow}>
            {onHold ? (
              <View style={[styles.pill, styles.holdPill]}>
                <Text style={styles.pillText}>On hold</Text>
              </View>
            ) : null}
            {noiseSuppressionEnabled && callType !== "video" ? (
              <View style={[styles.pill, styles.nsPill]}>
                <Text style={styles.pillText}>NS</Text>
              </View>
            ) : null}
            {recording ? (
              <View style={[styles.pill, styles.recPill]}>
                <Text style={styles.pillText}>REC</Text>
              </View>
            ) : null}
          </View>
          {peerMuted ? (
            <View style={styles.muteBadge}>
              <MicOff size={13} color="#fff" />
              <Text style={styles.muteBadgeText}>Muted</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {!isInPip && !hideChrome ? (
        <View style={[styles.info, { top: insets.top + 60 }]}>
          <Text style={styles.peerName} numberOfLines={1}>
            {peerName}
          </Text>
          {status === "connected" ? (
            <CallDurationComponent active style={styles.status} />
          ) : (
            <Text style={styles.status}>{statusLabel}</Text>
          )}
        </View>
      ) : null}

      {!isInPip && status === "connected" && peerQuality === "poor" ? (
        <View style={[styles.peerQualityBanner, { top: insets.top + 110 }]}>
          <Signal size={13} color="#fff" />
          <Text style={styles.peerQualityText} numberOfLines={1}>
            {peerName}&apos;s connection is unstable
          </Text>
        </View>
      ) : null}

      {!isInPip && !hideChrome ? (
        mode === "incoming" && status === "ringing" ? (
          <View
            style={[
              styles.incomingControls,
              { paddingBottom: Math.max(insets.bottom, 28) },
            ]}
          >
            <View style={styles.incomingBtnWrap}>
              <Pressable
                style={styles.reject}
                onPress={onRejectIncoming}
                hitSlop={8}
              >
                <PhoneOff size={30} color="#fff" />
              </Pressable>
              <Text style={styles.ctrlLabel}>Decline</Text>
            </View>
            <View style={styles.incomingBtnWrap}>
              <Pressable
                style={styles.accept}
                onPress={onAcceptIncoming}
                hitSlop={8}
              >
                <Phone size={30} color="#fff" />
              </Pressable>
              <Text style={styles.ctrlLabel}>Accept</Text>
            </View>
          </View>
        ) : (
          <View
            style={[
              styles.controlsBar,
              { paddingBottom: Math.max(insets.bottom, 20) },
            ]}
          >
            <View style={styles.controlsRow}>
              <Pressable
                style={[styles.ctrl, ctrlSizeStyle, muted && styles.ctrlActive]}
                onPress={onToggleMute}
                hitSlop={6}
              >
                {muted ? (
                  <MicOff size={ctrlIcon} color={CTRL_ON} />
                ) : (
                  <Mic size={ctrlIcon} color={CTRL_OFF} />
                )}
              </Pressable>
              {showVideo ? (
                <Pressable
                  style={[
                    styles.ctrl,
                    ctrlSizeStyle,
                    videoOff && styles.ctrlActive,
                  ]}
                  onPress={onToggleVideo}
                  hitSlop={6}
                >
                  {videoOff ? (
                    <VideoOff size={ctrlIcon} color={CTRL_ON} />
                  ) : (
                    <VideoIcon size={ctrlIcon} color={CTRL_OFF} />
                  )}
                </Pressable>
              ) : null}
              {showVideo ? (
                <Pressable
                  style={[styles.ctrl, ctrlSizeStyle]}
                  onPress={onSwitchCamera}
                  hitSlop={6}
                >
                  <SwitchCamera size={ctrlIcon} color={CTRL_OFF} />
                </Pressable>
              ) : null}
              <Pressable
                style={[
                  styles.ctrl,
                  ctrlSizeStyle,
                  speakerOn && styles.ctrlActive,
                ]}
                onPress={onToggleSpeaker}
                hitSlop={6}
              >
                {speakerOn ? (
                  <Volume2 size={ctrlIcon} color={CTRL_ON} />
                ) : (
                  <Volume1 size={ctrlIcon} color={CTRL_OFF} />
                )}
              </Pressable>
              {status === "connected" ? (
                <Pressable
                  style={[
                    styles.ctrl,
                    ctrlSizeStyle,
                    showMore && styles.ctrlActive,
                  ]}
                  onPress={onOpenMore}
                  hitSlop={6}
                >
                  <MoreVertical
                    size={ctrlIcon}
                    color={showMore ? CTRL_ON : CTRL_OFF}
                  />
                  {chatUnread > 0 && !showChat ? (
                    <View style={styles.unreadDot}>
                      <Text style={styles.unreadText}>
                        {chatUnread > 9 ? "9+" : chatUnread}
                      </Text>
                    </View>
                  ) : null}
                </Pressable>
              ) : null}
              <Pressable
                style={[styles.ctrlEnd, ctrlSizeStyle]}
                onPress={onEndCall}
                hitSlop={6}
              >
                <PhoneOff size={compactControls ? 24 : 26} color="#fff" />
              </Pressable>
            </View>
          </View>
        )
      ) : null}

      {!isInPip
        ? floatingReactions.map((r) => (
            <View
              key={r.id}
              style={[
                styles.floatingReaction,
                r.fromSelf
                  ? styles.floatingReactionSelf
                  : styles.floatingReactionPeer,
              ]}
            >
              <Text style={styles.floatingReactionText}>{r.emoji}</Text>
            </View>
          ))
        : null}

      <Modal
        visible={!isInPip && showMore}
        transparent
        animationType="slide"
        onRequestClose={onCloseMore}
      >
        <Pressable style={styles.sheetBackdrop} onPress={onCloseMore}>
          <Pressable style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetHeading}>More options</Text>
            <Pressable style={styles.sheetItem} onPress={onToggleHold}>
              <View style={styles.sheetIconWrap}>
                {onHold ? (
                  <Play size={20} color={CTRL_OFF} />
                ) : (
                  <Pause size={20} color={CTRL_OFF} />
                )}
              </View>
              <View style={styles.sheetItemBody}>
                <Text style={styles.sheetItemText}>
                  {onHold ? "Resume call" : "Hold call"}
                </Text>
                <Text style={styles.sheetItemSub}>
                  {onHold
                    ? "Reconnect your audio and video"
                    : "Pause your audio and video"}
                </Text>
              </View>
            </Pressable>
            <Pressable
              style={styles.sheetItem}
              onPress={onToggleNoiseSuppression}
            >
              <View style={styles.sheetIconWrap}>
                <Sparkles
                  size={20}
                  color={noiseSuppressionEnabled ? "#34d399" : CTRL_OFF}
                />
              </View>
              <View style={styles.sheetItemBody}>
                <Text style={styles.sheetItemText}>Noise suppression</Text>
                <Text style={styles.sheetItemSub}>
                  {noiseSuppressionEnabled ? "On" : "Off"}
                </Text>
              </View>
            </Pressable>
            <Pressable style={styles.sheetItem} onPress={onToggleRecording}>
              <View style={styles.sheetIconWrap}>
                <Disc size={20} color={recording ? "#f87171" : CTRL_OFF} />
              </View>
              <View style={styles.sheetItemBody}>
                <Text style={styles.sheetItemText}>
                  {recording ? "Stop recording" : "Record call"}
                </Text>
                <Text style={styles.sheetItemSub}>
                  {recording ? "Recording in progress" : "Capture this call"}
                </Text>
              </View>
            </Pressable>
            <Pressable style={styles.sheetItem} onPress={onOpenReactionPicker}>
              <View style={styles.sheetIconWrap}>
                <Smile size={20} color={CTRL_OFF} />
              </View>
              <View style={styles.sheetItemBody}>
                <Text style={styles.sheetItemText}>Send reaction</Text>
                <Text style={styles.sheetItemSub}>
                  Float an emoji on screen
                </Text>
              </View>
            </Pressable>
            {isGroupCall ? (
              <Pressable style={styles.sheetItem} onPress={onAddParticipant}>
                <View style={styles.sheetIconWrap}>
                  <MessageSquare size={20} color={CTRL_OFF} />
                </View>
                <View style={styles.sheetItemBody}>
                  <Text style={styles.sheetItemText}>Add participant</Text>
                  <Text style={styles.sheetItemSub}>
                    Invite another member to this call
                  </Text>
                </View>
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.sheetItem, styles.sheetItemLast]}
              onPress={onOpenChat}
            >
              <View style={styles.sheetIconWrap}>
                <MessageSquare size={20} color={CTRL_OFF} />
                {chatUnread > 0 ? (
                  <View style={styles.sheetUnreadDot}>
                    <Text style={styles.unreadText}>
                      {chatUnread > 9 ? "9+" : chatUnread}
                    </Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.sheetItemBody}>
                <Text style={styles.sheetItemText}>Open chat</Text>
                <Text style={styles.sheetItemSub}>
                  Message without leaving the call
                </Text>
              </View>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={!isInPip && showReactionPicker}
        transparent
        animationType="fade"
        onRequestClose={onCloseReactionPicker}
      >
        <Pressable style={styles.sheetBackdrop} onPress={onCloseReactionPicker}>
          <Pressable style={styles.reactionSheet}>
            {["👍", "👏", "❤️", "😂", "🎉", "🤔"].map((emoji) => (
              <Pressable
                key={emoji}
                style={styles.reactionBtn}
                onPress={() => onSendReaction(emoji)}
              >
                <Text style={styles.reactionBtnText}>{emoji}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={!isInPip && showChat}
        transparent
        animationType="slide"
        onRequestClose={onCloseChat}
      >
        <View style={styles.chatPanel}>
          <View style={styles.chatHeader}>
            <Text style={styles.chatTitle}>Call chat</Text>
            <Pressable onPress={onCloseChat}>
              <Text style={styles.chatClose}>Close</Text>
            </Pressable>
          </View>
          <ScrollView
            ref={chatScrollRef}
            style={styles.chatBody}
            onContentSizeChange={() =>
              chatScrollRef.current?.scrollToEnd({ animated: false })
            }
          >
            {callMessages.map((m) => {
              const mine = Number(m.senderId) !== Number(peerId);
              return (
                <View
                  key={String(m.id)}
                  style={[
                    styles.chatMsg,
                    mine ? styles.chatMsgMine : styles.chatMsgPeer,
                  ]}
                >
                  <Text style={styles.chatMsgSender}>
                    {mine ? "You" : m.senderName || peerName}
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
              onChangeText={onChangeChatText}
              placeholder="Type a message"
              placeholderTextColor="rgba(255,255,255,0.45)"
            />
            <Pressable style={styles.chatSendBtn} onPress={onSendChat}>
              <Text style={styles.chatSendText}>Send</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}
