import type { CSSProperties } from "react";
import { useState } from "react";
import {
  Pin,
  Star,
  Users,
  Trash2,
  BellOff,
  Bell,
  Archive,
  ArchiveRestore,
  ChevronRight,
  CheckSquare2,
  Square,
  MailOpen,
  Check,
} from "lucide-react";
import { ChatAvatar } from "../../components/chat";
import { fmtTime, getConvName, getConvAvatar, isUserOnline } from "./chatUtils";
import s from "./ChatSidebar.module.css";

/**
 * Signal-style last-message attachment label. Shows a type-aware emoji + word
 * (Photo / Video / GIF / Voice message / Audio / Document) instead of a plain
 * "Attachment". Falls back gracefully when type metadata is missing.
 */
function attachmentPreview(
  fileType?: string | null,
  fileName?: string | null,
  fileUrl?: string | null,
): string {
  const type = (fileType || "").toLowerCase();
  const name = (fileName || "").toLowerCase();
  const url = (fileUrl || "").toLowerCase();

  if (url.includes("voice") || name.startsWith("voice."))
    return "🎤 Voice message";
  if (type === "image/gif" || name.endsWith(".gif")) return "🎞️ GIF";
  if (type.startsWith("image/")) return "📷 Photo";
  if (type.startsWith("video/")) return "🎥 Video";
  if (type.startsWith("audio/")) return "🎵 Audio";
  if (type.includes("pdf")) return "📄 PDF";
  if (type.includes("spreadsheet") || type.includes("excel"))
    return "📊 Spreadsheet";
  if (type.includes("word") || type.includes("document")) return "📝 Document";
  if (type.includes("zip") || type.includes("compressed")) return "🗜️ Archive";
  if (fileName) return `📎 ${fileName}`;
  return "📎 Attachment";
}

interface ConversationItemProps {
  conv: any;
  activeConvId: number | string | null;
  typingUsers: Record<string, any>;
  onlineUsers: any;
  userStatusMap?: Record<string, string>;
  convMenu: any;
  userId?: number | string;
  onOpen: (c: any) => void;
  onMenuToggle: (id: number | string) => void;
  onPin: (id: number | string) => void;
  onFav: (id: number | string) => void;
  onDelete: (c: any) => void;
  onMute?: (
    id: number | string,
    duration: "1h" | "8h" | "1d" | "1w" | "always" | null,
  ) => void;
  onArchive?: (id: number | string) => void;
  onToggleRead?: (id: number | string, currentlyUnread: boolean) => void;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number | string) => void;
  onEnterSelection?: (id: number | string) => void;
}

const MUTE_OPTIONS: Array<{
  key: "1h" | "8h" | "1d" | "1w" | "always";
  label: string;
}> = [
  { key: "1h", label: "For 1 hour" },
  { key: "8h", label: "For 8 hours" },
  { key: "1d", label: "For 1 day" },
  { key: "1w", label: "For 1 week" },
  { key: "always", label: "Always" },
];

/**
 * Signal-style conversation-list delivery tick for the caller's OWN last
 * message: sent (bare ✓) → delivered (circled ✓) → read (accent-filled ✓).
 * Mirrors the in-thread DeliveryStatus glyphs so both screens read the same.
 */
function ListTick({ conv, userId }: { conv: any; userId?: number | string }) {
  if (userId == null || Number(conv.last_sender_id) !== Number(userId))
    return null;
  if (conv.last_format_type === "system" || conv.last_deleted) return null;
  const read = !!conv.last_message_read;
  const delivered = !!conv.last_message_delivered;
  // Sits on the right edge of the preview row, directly under the timestamp.
  const style: CSSProperties = {
    display: "inline-flex",
    verticalAlign: "middle",
    marginLeft: "auto",
    paddingLeft: "6px",
    flexShrink: 0,
    color: read ? "var(--primary)" : "var(--text-muted, #8a8f98)",
  };
  if (read) {
    return (
      <span style={style} title="Read" aria-label="Read">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.1" />
          <circle cx="8" cy="8" r="5.2" fill="currentColor" />
          <path
            d="M5.4 8.1l1.8 1.8L10.7 6"
            stroke="var(--read-check-bg, #fff)"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (delivered) {
    return (
      <span style={style} title="Delivered" aria-label="Delivered">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M4.6 8.2l2.2 2.2L11.4 5.6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  return (
    <span style={style} title="Sent" aria-label="Sent">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <path
          d="M3.5 8.5l3 3 6-7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export default function ConversationItem({
  conv,
  activeConvId,
  typingUsers,
  onlineUsers,
  userStatusMap = {},
  convMenu,
  userId,
  onOpen,
  onMenuToggle,
  onPin,
  onFav,
  onDelete,
  onMute,
  onArchive,
  onToggleRead,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onEnterSelection,
}: ConversationItemProps) {
  const c = conv;
  const [showMuteMenu, setShowMuteMenu] = useState(false);
  const otherStatus =
    !c.is_group && c.other_user_id ? userStatusMap[c.other_user_id] : undefined;
  return (
    <div
      className={`${s.convItem} ${activeConvId === c.id ? s.active : ""} ${
        selected ? s.convItemSelected : ""
      } ${selectionMode ? s.convItemSelectable : ""}`}
      onClick={() => (selectionMode ? onToggleSelect?.(c.id) : onOpen(c))}
      onContextMenu={(event) => {
        if (!onEnterSelection) return;
        event.preventDefault();
        if (!selectionMode) onEnterSelection(c.id);
      }}
    >
      {selectionMode && (
        <span className={s.convCheckbox} aria-hidden="true">
          {selected ? <CheckSquare2 size={20} /> : <Square size={20} />}
        </span>
      )}
      <ChatAvatar
        name={getConvName(c)}
        avatar={getConvAvatar(c)}
        size="md"
        online={isUserOnline(c, onlineUsers)}
        userStatus={otherStatus}
      />
      <div className={s.convInfo}>
        <div className={s.convTop}>
          <span className={s.convName}>
            {c.is_pinned && (
              <Pin
                size={12}
                style={{
                  display: "inline",
                  verticalAlign: "middle",
                  marginRight: "3px",
                }}
              />
            )}
            {c.is_favourite && !c.is_pinned && (
              <Star
                size={12}
                style={{
                  display: "inline",
                  verticalAlign: "middle",
                  marginRight: "3px",
                }}
              />
            )}
            {c.is_group && (
              <Users
                size={12}
                style={{
                  display: "inline",
                  verticalAlign: "middle",
                  marginRight: "3px",
                }}
              />
            )}
            {getConvName(c)}
            {c.is_muted && (
              <BellOff
                size={12}
                style={{
                  display: "inline",
                  verticalAlign: "middle",
                  marginLeft: "4px",
                  opacity: 0.55,
                }}
              />
            )}
          </span>
          <span className={s.convTime}>{fmtTime(c.last_message_at)}</span>
        </div>
        <div className={s.convPreview}>
          {typingUsers[c.id] ? (
            <span className={s.typing}>typing...</span>
          ) : (
            <span
              className={c.unread_count > 0 ? s.unread : ""}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {c.is_group && c.last_sender_name && !c.last_deleted
                ? `${c.last_sender_name.split(" ")[0]}: `
                : ""}
              {c.last_deleted
                ? "Message deleted"
                : c.last_message
                  ? c.last_message
                  : c.last_file_url
                    ? attachmentPreview(
                        c.last_file_type,
                        c.last_file_name,
                        c.last_file_url,
                      )
                    : "No messages yet"}
            </span>
          )}
          {!typingUsers[c.id] && <ListTick conv={c} userId={userId} />}
          {c.unread_count > 0 && (
            <span className={s.badge}>{c.unread_count}</span>
          )}
        </div>
      </div>
      <div className={s.convMenuWrap}>
        <button
          className={s.convMenuBtn}
          title="More options"
          onClick={(e) => {
            e.stopPropagation();
            onMenuToggle(c.id);
          }}
        >
          ⋮
        </button>
        {convMenu === c.id && (
          <div
            className={s.convMenuDropdown}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => onPin(c.id)}
              style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}
            >
              <Pin size={13} /> {c.is_pinned ? "Unpin" : "Pin chat"}
            </button>
            <button
              onClick={() => onFav(c.id)}
              style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}
            >
              <Star size={13} /> {c.is_favourite ? "Unfavourite" : "Favourite"}
            </button>
            {onMute &&
              (c.is_muted ? (
                <button
                  onClick={() => onMute(c.id, null)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.35rem",
                  }}
                >
                  <Bell size={13} /> Unmute
                </button>
              ) : (
                <div style={{ position: "relative" }}>
                  <button
                    onClick={() => setShowMuteMenu((v) => !v)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      width: "100%",
                    }}
                  >
                    <BellOff size={13} /> Mute…
                    <ChevronRight size={12} style={{ marginLeft: "auto" }} />
                  </button>
                  {showMuteMenu && (
                    <div
                      className={s.convMenuDropdown}
                      style={{
                        position: "absolute",
                        left: "100%",
                        top: 0,
                        marginLeft: "2px",
                      }}
                    >
                      {MUTE_OPTIONS.map((opt) => (
                        <button
                          key={opt.key}
                          onClick={() => {
                            setShowMuteMenu(false);
                            onMute(c.id, opt.key);
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            {onToggleRead && (
              <button
                onClick={() => onToggleRead(c.id, (c.unread_count || 0) > 0)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                }}
              >
                {(c.unread_count || 0) > 0 ? (
                  <>
                    <Check size={13} /> Mark as read
                  </>
                ) : (
                  <>
                    <MailOpen size={13} /> Mark as unread
                  </>
                )}
              </button>
            )}
            {onArchive && (
              <button
                onClick={() => onArchive(c.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                }}
              >
                {c.is_archived ? (
                  <>
                    <ArchiveRestore size={13} /> Unarchive
                  </>
                ) : (
                  <>
                    <Archive size={13} /> Archive
                  </>
                )}
              </button>
            )}
            <button
              className={s.menuDanger}
              onClick={() => onDelete(c)}
              style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}
            >
              <Trash2 size={13} /> Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
