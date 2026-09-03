import { useEffect, useMemo, useState } from "react";
import { Send, Timer, X } from "lucide-react";
import s from "./VideoPreview.module.css";

interface VideoPreviewProps {
  file: File;
  onSend: (
    file: File,
    options: { caption?: string; viewOnce?: boolean },
  ) => void;
  onClose: () => void;
}

export default function VideoPreview({
  file,
  onSend,
  onClose,
}: VideoPreviewProps) {
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);
  const [caption, setCaption] = useState("");
  const [viewOnce, setViewOnce] = useState(false);

  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);

  return (
    <div
      className={s.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Review video"
    >
      <div className={s.topBar}>
        <button
          className={s.iconButton}
          onClick={onClose}
          aria-label="Discard video"
        >
          <X size={22} />
        </button>
        <strong>Review video</strong>
        <span className={s.fileName} title={file.name}>
          {file.name}
        </span>
      </div>

      <div className={s.stage}>
        <video
          src={previewUrl}
          controls
          autoPlay
          playsInline
          className={s.video}
        />
      </div>

      <div className={s.options}>
        <button
          type="button"
          className={`${s.viewOnce} ${viewOnce ? s.viewOnceActive : ""}`}
          onClick={() => setViewOnce((current) => !current)}
          aria-pressed={viewOnce}
        >
          <Timer size={16} />
          {viewOnce ? "View once" : "View ∞"}
        </button>
      </div>

      <div className={s.bottomBar}>
        <input
          className={s.caption}
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          placeholder="Add a caption…"
          maxLength={5000}
        />
        <button
          className={s.sendButton}
          onClick={() =>
            onSend(file, {
              caption: caption.trim() || undefined,
              viewOnce,
            })
          }
          aria-label="Send video"
        >
          <Send size={20} />
        </button>
      </div>
    </div>
  );
}
