import type { MutableRefObject } from "react";

type ControlDeps = {
  conversationId: number;
  callType: "voice" | "video";
  chatText: string;
  noiseSuppressionEnabled: boolean;
  muted: boolean;
  videoOff: boolean;
  onHold: boolean;
  localStreamRef: MutableRefObject<any>;
  peerIdRef: MutableRefObject<number | null>;
  callIdRef: MutableRefObject<number | null>;
  holdSnapshotRef: MutableRefObject<{
    muted: boolean;
    videoOff: boolean;
  } | null>;
  sendSocket: (event: string, payload: any) => void;
  // Reliable, retrying sender used for state signals that MUST reach the peer
  // (video-state / audio-state / reaction). A dropped fire-and-forget frame is
  // the root cause of a "stuck last frame" on the peer after camera-off and of
  // reactions never appearing on the other screen. Falls back to sendSocket
  // when not provided.
  sendSocketReliable?: (event: string, payload: any) => void | Promise<unknown>;
  setOnHold: (value: boolean) => void;
  setMuted: (value: boolean) => void;
  setVideoOff: (value: boolean) => void;
  setUsingFrontCamera: (updater: (prev: boolean) => boolean) => void;
  setNoiseSuppressionEnabled: (value: boolean) => void;
  setRecording: (updater: (prev: boolean) => boolean) => void;
  setSpeakerOn: (updater: (prev: boolean) => boolean) => void;
  setFloatingReactions: (
    updater: (
      prev: Array<{ id: number; emoji: string; fromSelf: boolean }>,
    ) => Array<{
      id: number;
      emoji: string;
      fromSelf: boolean;
    }>,
  ) => void;
  setShowReactionPicker: (value: boolean) => void;
  setShowMore: (value: boolean) => void;
  setChatText: (value: string) => void;
  setShowChat: (value: boolean | ((prev: boolean) => boolean)) => void;
  setChatUnread: (value: number) => void;
};

export function useMobileCallControls(deps: ControlDeps) {
  const sendReliable = deps.sendSocketReliable || deps.sendSocket;
  function toggleMute() {
    deps.setOnHold(false);
    deps.holdSnapshotRef.current = null;
    const stream = deps.localStreamRef.current;
    if (!stream) return;
    const next = !deps.muted;
    stream.getAudioTracks().forEach((t: any) => {
      t.enabled = !next;
    });
    deps.setMuted(next);
    const target = deps.peerIdRef.current;
    if (target) {
      sendReliable("call_signal", {
        conversationId: deps.conversationId,
        callId: deps.callIdRef.current,
        targetUserId: target,
        signal: { type: "audio-state", muted: next },
      });
    }
  }

  function toggleVideo() {
    deps.setOnHold(false);
    deps.holdSnapshotRef.current = null;
    const stream = deps.localStreamRef.current;
    if (!stream) return;
    const next = !deps.videoOff;
    stream.getVideoTracks().forEach((t: any) => {
      t.enabled = !next;
    });
    deps.setVideoOff(next);
    const target = deps.peerIdRef.current;
    if (target) {
      sendReliable("call_signal", {
        conversationId: deps.conversationId,
        callId: deps.callIdRef.current,
        targetUserId: target,
        signal: { type: "video-state", videoOff: next },
      });
    }
  }

  function switchCamera() {
    const stream = deps.localStreamRef.current;
    stream?.getVideoTracks().forEach((t: any) => {
      (t as any)._switchCamera?.();
    });
    deps.setUsingFrontCamera((v) => !v);
  }

  function toggleHold() {
    const stream = deps.localStreamRef.current;
    if (!stream) return;
    const next = !deps.onHold;
    if (next) {
      deps.holdSnapshotRef.current = {
        muted: deps.muted,
        videoOff: deps.videoOff,
      };
      stream.getAudioTracks().forEach((t: any) => {
        t.enabled = false;
      });
      stream.getVideoTracks().forEach((t: any) => {
        t.enabled = false;
      });
      deps.setMuted(true);
      deps.setVideoOff(true);
    } else {
      const snap = deps.holdSnapshotRef.current || {
        muted: false,
        videoOff: true,
      };
      stream.getAudioTracks().forEach((t: any) => {
        t.enabled = !snap.muted;
      });
      stream.getVideoTracks().forEach((t: any) => {
        t.enabled = !snap.videoOff;
      });
      deps.setMuted(snap.muted);
      deps.setVideoOff(snap.videoOff);
    }
    const target = deps.peerIdRef.current;
    if (target) {
      sendReliable("call_signal", {
        conversationId: deps.conversationId,
        callId: deps.callIdRef.current,
        targetUserId: target,
        signal: { type: "audio-state", muted: next ? true : deps.muted },
      });
      sendReliable("call_signal", {
        conversationId: deps.conversationId,
        callId: deps.callIdRef.current,
        targetUserId: target,
        signal: { type: "video-state", videoOff: next ? true : deps.videoOff },
      });
    }
    deps.setOnHold(next);
  }

  function toggleNoiseSuppression() {
    const next = !deps.noiseSuppressionEnabled;
    const stream = deps.localStreamRef.current;
    if (stream) {
      stream.getAudioTracks().forEach((track: any) => {
        track
          .applyConstraints?.({
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: next,
          } as any)
          .catch(() => {});
      });
    }
    deps.setNoiseSuppressionEnabled(next);
  }

  function toggleRecording() {
    deps.setRecording((v) => !v);
  }

  function toggleSpeaker() {
    // Works for both voice and video calls. Voice calls default to the earpiece
    // and video calls to the loudspeaker; this lets the user flip the route
    // either way (the audio mode effect reacts to `speakerOn`).
    deps.setSpeakerOn((v) => !v);
  }

  function sendReaction(emoji: string) {
    const targetUserId = deps.peerIdRef.current;
    if (!targetUserId) return;
    sendReliable("call_reaction", {
      conversationId: deps.conversationId,
      targetUserId,
      emoji,
    });
    const id = Date.now() + Math.random();
    deps.setFloatingReactions((prev) => [
      ...prev,
      { id, emoji, fromSelf: true },
    ]);
    setTimeout(
      () =>
        deps.setFloatingReactions((prev) => prev.filter((r) => r.id !== id)),
      2500,
    );
    deps.setShowReactionPicker(false);
    deps.setShowMore(false);
  }

  function sendChat() {
    const content = deps.chatText.trim();
    if (!content) return;
    deps.sendSocket("chat_message", {
      conversationId: deps.conversationId,
      content,
    });
    deps.setChatText("");
  }

  function toggleChatPanel() {
    deps.setShowChat((v) => !v);
    deps.setChatUnread(0);
  }

  function openChatPanel() {
    deps.setShowMore(false);
    deps.setShowChat(true);
    deps.setChatUnread(0);
  }

  function closeChatPanel() {
    deps.setShowChat(false);
  }

  function openMorePanel() {
    deps.setShowMore(true);
  }

  function closeMorePanel() {
    deps.setShowMore(false);
  }

  function openReactionPickerFromMore() {
    deps.setShowMore(false);
    deps.setShowReactionPicker(true);
  }

  function closeReactionPicker() {
    deps.setShowReactionPicker(false);
  }

  return {
    toggleMute,
    toggleVideo,
    switchCamera,
    toggleHold,
    toggleNoiseSuppression,
    toggleRecording,
    toggleSpeaker,
    sendReaction,
    sendChat,
    toggleChatPanel,
    openChatPanel,
    closeChatPanel,
    openMorePanel,
    closeMorePanel,
    openReactionPickerFromMore,
    closeReactionPicker,
  };
}
