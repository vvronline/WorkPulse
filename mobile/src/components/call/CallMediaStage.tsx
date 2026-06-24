import { Image, Text, View } from "react-native";
import {
  CallDuration,
  DraggablePipSelfView,
  FullScreenSelfView,
  RemoteVideo,
} from "./CallVideoPrimitives";

type CallStatus = "ringing" | "connecting" | "connected" | "reconnecting" | "ended" | "rejected";

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
        <View style={styles.avatarWrap}>
          <View style={styles.avatar}>
            {peerAvatarUrl ? (
              <Image source={{ uri: peerAvatarUrl }} style={styles.avatarImg} />
            ) : (
              <Text style={styles.avatarText}>{(peerName || "?")[0]?.toUpperCase()}</Text>
            )}
          </View>
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
