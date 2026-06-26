import { Image, Text, useColorScheme, View } from "react-native";
import {
  CallDuration,
  DraggablePipSelfView,
  FullScreenSelfView,
  RemoteVideo,
} from "./CallVideoPrimitives";

type CallStatus =
  | "ringing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "rejected";

type Props = {
  styles: any;
  isInPip: boolean;
  showRemoteVideo: boolean;
  remoteURL: string | null;
  showFullScreenSelfPreview: boolean;
  localURL: string | null;
  usingFrontCamera: boolean;
  peerAvatarUrl: string | null;
  peerName: string;
  showPipSelfPreview: boolean;
  insets: { top: number; bottom: number };
  status: CallStatus;
  statusLabel: string;
};

export default function CallMediaStage({
  styles,
  isInPip,
  showRemoteVideo,
  remoteURL,
  showFullScreenSelfPreview,
  localURL,
  usingFrontCamera,
  peerAvatarUrl,
  peerName,
  showPipSelfPreview,
  insets,
  status,
  statusLabel,
}: Props) {
  // The video-off / voice fallback follows the DEVICE's system colour scheme
  // (light or dark) rather than the always-dark call surface, so a stuck video
  // frame never lingers — when the peer turns their camera off we paint a clean
  // themed background with their name + avatar (Signal/WhatsApp behaviour).
  const scheme = useColorScheme();
  const isLight = scheme === "light";
  const fallbackBg = isLight ? "#f2f2f7" : "#0a0a0a";
  const fallbackName = isLight ? "#111111" : "#ffffff";
  return (
    <>
      {showRemoteVideo && remoteURL ? (
        <RemoteVideo url={remoteURL} style={styles.remoteVideo} />
      ) : showFullScreenSelfPreview && localURL ? (
        <FullScreenSelfView
          url={localURL}
          mirror={usingFrontCamera}
          style={styles.remoteVideo}
        />
      ) : (
        <View style={[styles.avatarWrap, { backgroundColor: fallbackBg }]}>
          <View style={styles.avatar}>
            {peerAvatarUrl ? (
              <Image source={{ uri: peerAvatarUrl }} style={styles.avatarImg} />
            ) : (
              <Text style={styles.avatarText}>
                {(peerName || "?")[0]?.toUpperCase()}
              </Text>
            )}
          </View>
          {!isInPip && peerName ? (
            <Text
              style={[styles.avatarName, { color: fallbackName }]}
              numberOfLines={1}
            >
              {peerName}
            </Text>
          ) : null}
        </View>
      )}

      {!isInPip && showPipSelfPreview && localURL ? (
        <DraggablePipSelfView
          url={localURL}
          mirror={usingFrontCamera}
          topInset={insets.top}
          bottomInset={insets.bottom}
        />
      ) : null}

      {isInPip && !showRemoteVideo ? (
        <View style={styles.pipVoiceOverlay} pointerEvents="none">
          <Text style={styles.pipVoiceName} numberOfLines={1}>
            {peerName}
          </Text>
          {status === "connected" ? (
            <CallDuration active style={styles.pipVoiceStatus} />
          ) : (
            <Text style={styles.pipVoiceStatus} numberOfLines={1}>
              {statusLabel}
            </Text>
          )}
        </View>
      ) : null}
    </>
  );
}
