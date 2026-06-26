import type { ComponentType } from "react";
import {
  useWindowDimensions,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  Mic,
  MicOff,
  MoreVertical,
  Phone,
  PhoneOff,
  Signal,
  SwitchCamera,
  Video as VideoIcon,
  VideoOff,
  Volume1,
  Volume2,
} from "lucide-react-native";

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
  const compactControls = screenWidth < 380;
  const ctrlDim = compactControls ? 50 : 58;
  const ctrlIcon = compactControls ? 22 : 24;
  const ctrlSizeStyle = {
    width: ctrlDim,
    height: ctrlDim,
    borderRadius: ctrlDim / 2,
  };

  return (
    <>
      {!isInPip && status === "connected" ? (
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
            {noiseSuppressionEnabled ? (
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

      {!isInPip ? (
        <View style={[styles.info, { top: insets.top + 60 }]}>
          <Text style={styles.peerName}>{peerName}</Text>
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

      {!isInPip ? (
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
        animationType="fade"
        onRequestClose={onCloseMore}
      >
        <Pressable style={styles.sheetBackdrop} onPress={onCloseMore}>
          <Pressable style={styles.sheet}>
            <Pressable style={styles.sheetItem} onPress={onToggleHold}>
              <Text style={styles.sheetItemText}>
                {onHold ? "Resume call" : "Hold call"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.sheetItem}
              onPress={onToggleNoiseSuppression}
            >
              <Text style={styles.sheetItemText}>
                {noiseSuppressionEnabled
                  ? "Disable noise suppression"
                  : "Enable noise suppression"}
              </Text>
            </Pressable>
            <Pressable style={styles.sheetItem} onPress={onToggleRecording}>
              <Text style={styles.sheetItemText}>
                {recording ? "Stop call recording" : "Record call"}
              </Text>
            </Pressable>
            <Pressable style={styles.sheetItem} onPress={onOpenReactionPicker}>
              <Text style={styles.sheetItemText}>Send reaction</Text>
            </Pressable>
            <Pressable style={styles.sheetItem} onPress={onOpenChat}>
              <Text style={styles.sheetItemText}>Open chat</Text>
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
          <ScrollView style={styles.chatBody}>
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
