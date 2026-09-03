import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { useAuth } from "../../auth/AuthContext";
import { useDialog } from "../../hooks/useDialog";
import {
  cancelChatMediaJob,
  retryChatMediaJob,
  uploadChatFile,
  type ChatMessage,
} from "../../features";
import { replaceUploadedMessage } from "./chatMessageReducers";
import { normalizeUploadedMessage } from "./chatThreadMessageUtils";
import type { PendingMediaSource } from "./useMobileConversationDraft";

type ThreadUser = ReturnType<typeof useAuth>["user"];

type UseChatMediaUploadsOptions = {
  convId: number;
  user: ThreadUser;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  requestTailScroll: (animated?: boolean) => void;
  alert: ReturnType<typeof useDialog>["alert"];
};

/**
 * Attachment pipeline for the thread: picking / capturing media, the optimistic
 * bubble, the per-upload AbortController + throughput sampler, and the
 * cancel/retry actions for both in-flight uploads and server-side media jobs.
 *
 * The upload source map is also handed to the draft hook so a restored media
 * draft can be retried with the original picker payload.
 */
export default function useChatMediaUploads({
  convId,
  user,
  setMessages,
  requestTailScroll,
  alert,
}: UseChatMediaUploadsOptions) {
  const [uploading, setUploading] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  // Signal-style in-app camera (full-screen). Opened from the composer camera
  // button; supports tap-for-photo / hold-for-video + an in-camera recent-
  // gallery strip (see CameraCapture).
  const [cameraOpen, setCameraOpen] = useState(false);
  // Signal-style media editor: the picked/captured images awaiting edit + send.
  const [editorItems, setEditorItems] = useState<
    { uri: string; width?: number; height?: number }[] | null
  >(null);
  // Captured/picked VIDEO awaiting review in the Signal-style preview screen
  // (caption + view-once + send/discard). Videos used to upload the instant the
  // shutter was released, with no chance to review or cancel.
  const [videoPreview, setVideoPreview] = useState<{
    uri: string;
    fileName: string;
    mimeType: string;
    width?: number;
    height?: number;
  } | null>(null);
  const [tenorOpen, setTenorOpen] = useState(false);
  const [tenorKind, setTenorKind] = useState<"gif" | "sticker">("gif");

  const mediaUploadControllers = useRef<Map<number, AbortController>>(
    new Map(),
  );
  const mediaUploadSources = useRef<Map<number, PendingMediaSource>>(new Map());
  // Per-upload throughput sampler: last {timestamp, bytes} so we can derive a
  // live bytes/sec speed for the Signal-style upload label.
  const uploadProgressTs = useRef<Map<number, { t: number; loaded: number }>>(
    new Map(),
  );

  useEffect(
    () => () => {
      for (const controller of mediaUploadControllers.current.values()) {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }
      mediaUploadControllers.current.clear();
      mediaUploadSources.current.clear();
      uploadProgressTs.current.clear();
    },
    [],
  );

  const uploadSingleMedia = useCallback(
    async (tempId: number, source: PendingMediaSource) => {
      const controller = new AbortController();
      mediaUploadControllers.current.set(tempId, controller);
      setUploading(true);
      try {
        const { data } = await uploadChatFile(
          convId,
          source.uri,
          source.fileName,
          source.mimeType,
          {
            viewOnce: source.viewOnce,
            caption: source.caption,
            width: source.width,
            height: source.height,
            quality: source.quality,
            signal: controller.signal,
            onUploadProgress: (evt) => {
              const total = evt.total || 0;
              const progress =
                total > 0
                  ? Math.max(
                      0,
                      Math.min(100, Math.round((evt.loaded / total) * 100)),
                    )
                  : 0;
              // Live throughput (bytes/sec) for the Signal-style speed label.
              const now = Date.now();
              const prevTs = uploadProgressTs.current.get(tempId);
              let speed = 0;
              if (prevTs && now > prevTs.t) {
                const dBytes = evt.loaded - prevTs.loaded;
                const dt = (now - prevTs.t) / 1000;
                if (dt > 0 && dBytes > 0) speed = dBytes / dt;
              }
              uploadProgressTs.current.set(tempId, {
                t: now,
                loaded: evt.loaded,
              });
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === tempId
                    ? {
                        ...m,
                        _mediaState: "uploading",
                        _mediaProgress: progress,
                        _uploadSpeed: speed || m._uploadSpeed,
                      }
                    : m,
                ),
              );
            },
          },
        );
        uploadProgressTs.current.delete(tempId);
        const normalized = normalizeUploadedMessage(data);
        setMessages((prev) =>
          replaceUploadedMessage(prev, tempId, normalized),
        );
        mediaUploadControllers.current.delete(tempId);
        mediaUploadSources.current.delete(tempId);
        if (mediaUploadControllers.current.size === 0) setUploading(false);
      } catch (e: any) {
        mediaUploadControllers.current.delete(tempId);
        if (mediaUploadControllers.current.size === 0) setUploading(false);
        const cancelled =
          e?.name === "CanceledError" ||
          e?.code === "ERR_CANCELED" ||
          e?.message === "canceled";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId
              ? {
                  ...m,
                  _pending: false,
                  _failed: true,
                  _mediaState: "failed",
                  _failureReason: cancelled
                    ? "Upload cancelled"
                    : e?.response?.data?.error || "Could not send this media.",
                }
              : m,
          ),
        );
      }
    },
    [convId, setMessages],
  );

  const enqueueMediaUpload = useCallback(
    (source: PendingMediaSource) => {
      const tempId = -(Date.now() + Math.floor(Math.random() * 1000));
      mediaUploadSources.current.set(tempId, source);
      // Carry intrinsic dimensions in metadata so the optimistic bubble sizes
      // itself by aspect ratio immediately (Signal-style) — no reflow once the
      // server row arrives.
      const dimMeta =
        source.width && source.height
          ? { width: source.width, height: source.height }
          : {};
      const mediaMeta = {
        ...dimMeta,
        ...(source.quality ? { quality: source.quality } : {}),
      };
      setMessages((prev) => [
        ...prev,
        {
          id: tempId,
          sender_id: user?.id || 0,
          sender_name: user?.full_name || "You",
          content: source.caption || "",
          created_at: new Date().toISOString(),
          file_url: source.uri,
          file_name: source.fileName,
          file_type: source.mimeType || null,
          file_size: null,
          metadata: source.viewOnce
            ? { viewOnce: true, viewedBy: [], ...mediaMeta }
            : Object.keys(mediaMeta).length
              ? mediaMeta
              : null,
          reactions: [],
          _pending: true,
          _failed: false,
          _mediaState: "queued",
          _mediaProgress: 0,
          _failureReason: null,
        },
      ]);
      uploadSingleMedia(tempId, source);
      requestTailScroll(true);
    },
    [
      requestTailScroll,
      setMessages,
      uploadSingleMedia,
      user?.full_name,
      user?.id,
    ],
  );

  async function uploadPickedMedia(
    uri: string,
    fallbackName: string,
    mimeType?: string,
  ) {
    enqueueMediaUpload({ uri, fileName: fallbackName, mimeType });
  }

  async function attachFile() {
    setPlusOpen(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      alert("Permission needed", "Allow Photos access to share media.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
      allowsMultipleSelection: true,
    });
    if (result.canceled || !result.assets?.length) return;
    // Route picked images through the Signal-style media editor.
    setEditorItems(
      result.assets.map((a) => ({
        uri: a.uri,
        width: a.width,
        height: a.height,
      })),
    );
  }

  // Open the Signal-style in-app camera (full-screen). Replaces the old OS-only
  // image picker so the user can TAP for a photo, HOLD for video, flip/flash and
  // pick from a recent-gallery strip — none of which the OS launchCameraAsync
  // (image-only) supported. The camera UI lives in CameraCapture, rendered as a
  // full-screen Modal by the chat screen; its callbacks below route captures.
  function attachCamera() {
    setPlusOpen(false);
    setCameraOpen(true);
  }

  // A still PHOTO captured in the in-app camera → close the camera and route it
  // through the Signal-style media editor (pen/crop/quality/view-once + caption).
  const handleCameraPhoto = useCallback(
    (item: { uri: string; width?: number; height?: number }) => {
      setCameraOpen(false);
      setEditorItems([
        { uri: item.uri, width: item.width, height: item.height },
      ]);
    },
    [],
  );

  // A recorded VIDEO from the in-app camera → close the camera and open the
  // Signal-style preview (review + caption + view-once + send/discard) instead
  // of uploading immediately on shutter release.
  const handleCameraVideo = useCallback(
    (item: {
      uri: string;
      fileName: string;
      mimeType: string;
      width?: number;
      height?: number;
    }) => {
      setCameraOpen(false);
      setVideoPreview({
        uri: item.uri,
        fileName: item.fileName,
        mimeType: item.mimeType,
        width: item.width,
        height: item.height,
      });
    },
    [],
  );

  // Send the previewed video (from the VideoPreview screen) with its caption and
  // view-once flag.
  const sendVideoPreview = useCallback(
    (opts: { caption?: string; viewOnce: boolean }) => {
      const v = videoPreview;
      setVideoPreview(null);
      if (!v) return;
      enqueueMediaUpload({
        uri: v.uri,
        fileName: v.fileName,
        mimeType: v.mimeType,
        viewOnce: opts.viewOnce,
        caption: opts.caption,
        width: v.width,
        height: v.height,
      });
    },
    [videoPreview, enqueueMediaUpload],
  );

  // A recent-gallery thumbnail tapped inside the in-app camera (or the "+"
  // attach sheet). Images go through the editor; videos upload directly.
  const handlePickRecentMedia = useCallback(
    (item: {
      uri: string;
      width?: number;
      height?: number;
      kind: "image" | "video";
      fileName?: string;
      mimeType?: string;
    }) => {
      setCameraOpen(false);
      setPlusOpen(false);
      if (item.kind === "video") {
        // Route videos through the review/caption preview (same as a recorded
        // clip) rather than uploading on tap.
        setVideoPreview({
          uri: item.uri,
          fileName: item.fileName || `video-${Date.now()}.mp4`,
          mimeType: item.mimeType || "video/mp4",
          width: item.width,
          height: item.height,
        });
      } else {
        setEditorItems([
          { uri: item.uri, width: item.width, height: item.height },
        ]);
      }
    },
    [],
  );

  // Called by the MediaEditor when the user taps Send. Each processed item is
  // enqueued for upload carrying its view-once flag + caption.
  const handleMediaEditorSend = useCallback(
    (
      results: {
        uri: string;
        fileName: string;
        mimeType: string;
        viewOnce: boolean;
        caption?: string;
        width: number;
        height: number;
        quality: "standard" | "hd";
      }[],
    ) => {
      results.forEach((r, i) => {
        enqueueMediaUpload({
          uri: r.uri,
          fileName: r.fileName,
          mimeType: r.mimeType,
          viewOnce: r.viewOnce,
          width: r.width,
          height: r.height,
          quality: r.quality,
          // Attach the caption to the first item only (matches Signal/web).
          caption: i === 0 ? r.caption : undefined,
        });
      });
      setEditorItems(null);
    },
    [enqueueMediaUpload],
  );

  async function attachGifFromEmoji() {
    setTenorKind("gif");
    setTenorOpen(true);
  }

  async function attachStickerFromEmoji() {
    setTenorKind("sticker");
    setTenorOpen(true);
  }

  async function pickTenorMedia(
    item: { mediaUrl: string },
    kind: "gif" | "sticker",
  ) {
    try {
      setTenorOpen(false);
      const ext = kind === "sticker" ? "webp" : "gif";
      const target = `${FileSystem.cacheDirectory}${kind}-${Date.now()}.${ext}`;
      const dl = await FileSystem.downloadAsync(item.mediaUrl, target);
      if (dl.status !== 200) {
        alert("Upload failed", "Could not download selected media.");
        return;
      }
      await uploadPickedMedia(
        dl.uri,
        `${kind}-${Date.now()}.${ext}`,
        kind === "sticker" ? "image/webp" : "image/gif",
      );
    } catch (e: any) {
      alert("Upload failed", e?.message || "Could not attach selected media.");
    }
  }

  // Document attachment — the old single "Photo / File" option only opened
  // the IMAGE library despite its label, so PDFs/docs could never be sent
  // from mobile (the web supports them). Uses expo-document-picker.
  async function attachDocument() {
    setPlusOpen(false);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const asset = result.assets[0];
      await uploadPickedMedia(
        asset.uri,
        asset.name || `file-${Date.now()}`,
        asset.mimeType || undefined,
      );
    } catch (e: any) {
      alert(
        "Upload failed",
        e?.response?.data?.error || "Could not send this file.",
      );
    }
  }

  const cancelMediaUpload = useCallback(
    (message: ChatMessage) => {
      const id = Number(message.id);
      const mediaJobId = Number(message.media_job_id || 0);
      if (mediaJobId > 0) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === message.id
              ? {
                  ...m,
                  _pending: false,
                  _failed: true,
                  _mediaState: "failed",
                  _failureReason: "Upload cancelled",
                }
              : m,
          ),
        );
        cancelChatMediaJob(mediaJobId).catch(() => {});
        return;
      }
      if (!Number.isFinite(id) || id >= 0) return;
      const controller = mediaUploadControllers.current.get(id);
      controller?.abort();
    },
    [setMessages],
  );

  const retryMediaUpload = useCallback(
    (message: ChatMessage) => {
      const id = Number(message.id);
      const mediaJobId = Number(message.media_job_id || 0);
      if (mediaJobId > 0) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === message.id
              ? {
                  ...m,
                  _pending: true,
                  _failed: false,
                  _mediaState: "queued",
                  _mediaProgress: 0,
                  _failureReason: null,
                }
              : m,
          ),
        );
        retryChatMediaJob(mediaJobId).catch((e: any) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === message.id
                ? {
                    ...m,
                    _pending: false,
                    _failed: true,
                    _mediaState: "failed",
                    _failureReason: e?.response?.data?.error || "Retry failed",
                  }
                : m,
            ),
          );
        });
        return;
      }
      if (!Number.isFinite(id) || id >= 0) return;
      const source = mediaUploadSources.current.get(id);
      if (!source) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id
            ? {
                ...m,
                _pending: true,
                _failed: false,
                _mediaState: "queued",
                _mediaProgress: 0,
                _failureReason: null,
              }
            : m,
        ),
      );
      uploadSingleMedia(id, source);
    },
    [setMessages, uploadSingleMedia],
  );

  return {
    uploading,
    setUploading,
    plusOpen,
    setPlusOpen,
    cameraOpen,
    setCameraOpen,
    editorItems,
    setEditorItems,
    videoPreview,
    setVideoPreview,
    tenorOpen,
    setTenorOpen,
    tenorKind,
    mediaUploadControllers,
    mediaUploadSources,
    enqueueMediaUpload,
    attachFile,
    attachCamera,
    handleCameraPhoto,
    handleCameraVideo,
    sendVideoPreview,
    handlePickRecentMedia,
    handleMediaEditorSend,
    attachGifFromEmoji,
    attachStickerFromEmoji,
    pickTenorMedia,
    attachDocument,
    cancelMediaUpload,
    retryMediaUpload,
  };
}
