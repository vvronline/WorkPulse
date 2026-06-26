import InCallManager from 'react-native-incall-manager';
import { Platform } from 'react-native';

/**
 * Manages the in-call audio session for WebRTC calls.
 *
 * react-native-webrtc does NOT automatically configure the device audio session.
 * Without starting the in-call audio session, the remote audio track is received
 * but never routed to the speaker/earpiece, so both sides hear silence even
 * though the connection reports "connected".
 *
 * This service centralizes that lifecycle:
 *  - start() when a call becomes active (offer/answer created)
 *  - setSpeaker() to route between earpiece and loudspeaker
 *  - stop() when the call ends
 */

let started = false;

export function startCallAudio(isVideo: boolean): void {
  try {
    // `media: 'video'` defaults the route to speaker, `'audio'` to earpiece.
    InCallManager.start({ media: isVideo ? 'video' : 'audio', auto: true });

    // Keep the proximity sensor / screen behavior sensible for audio calls.
    if (!isVideo) {
      InCallManager.setForceSpeakerphoneOn(false);
    } else {
      InCallManager.setForceSpeakerphoneOn(true);
    }
    started = true;
  } catch {
    // If the native module is unavailable (e.g. running in Expo Go), fail soft.
    started = false;
  }
}

export function setCallSpeaker(on: boolean): void {
  try {
    // `setForceSpeakerphoneOn(null)` lets the OS decide; we want explicit control.
    InCallManager.setForceSpeakerphoneOn(on);
    if (Platform.OS === 'android') {
      InCallManager.setSpeakerphoneOn(on);
    }
  } catch {
    // ignore
  }
}

export function setCallMicMuted(muted: boolean): void {
  try {
    InCallManager.setMicrophoneMute(muted);
  } catch {
    // ignore
  }
}

export function stopCallAudio(): void {
  if (!started) {
    // Still attempt a stop in case start partially succeeded.
  }
  try {
    InCallManager.setForceSpeakerphoneOn(false);
    InCallManager.stop();
  } catch {
    // ignore
  } finally {
    started = false;
  }
}