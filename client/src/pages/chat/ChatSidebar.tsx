import {
  Pin,
  Star,
  Users,
  UserPlus,
  X,
  Search,
  Phone,
  MessageSquare,
  Video,
  Archive,
  ChevronLeft,
  CheckSquare2,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import ConfirmDialog from "../../components/common/ConfirmDialog";
import { ChatAvatar } from "../../components/chat";
import { useFeatures } from "../../FeaturesContext";
import { getConvName } from "./chatUtils";
import ConversationItem from "./ConversationItem";
import CallsTab from "./CallsTab";
import s from "./ChatSidebar.module.css";

interface ChatSidebarProps {
  conversations: any[];
  activeConvId: number | string | null;
  search: string;
  setSearch: (val: string) => void;
  searchResults: any[];
  searching: boolean;
  typingUsers: Record<string, any>;
  onlineUsers: any;
  userStatusMap?: Record<string, string>;
  convMenu: any;
  mobileView: string;
  userId: number | string;
  loadingConvs: boolean;
  onSearchUser: (u: any) => void;
  onOpenConv: (...args: any[]) => void;
  onMenuToggle: (...args: any[]) => void;
  onPinConv: (...args: any[]) => void;
  onFavConv: (...args: any[]) => void;
  onDeleteConv: (...args: any[]) => void;
  onMuteConv?: (...args: any[]) => void;
  onArchiveConv?: (...args: any[]) => void;
  onToggleReadConv?: (...args: any[]) => void;
  onBulkDeleteConversations?: (ids: Array<number | string>) => Promise<void>;
  onNewGroup: () => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
}

export default function ChatSidebar({
  conversations,
  activeConvId,
  search,
  setSearch,
  searchResults,
  searching,
  typingUsers,
  onlineUsers,
  userStatusMap = {},
  convMenu,
  mobileView,
  userId,
  loadingConvs,
  onSearchUser,
  onOpenConv,
  onMenuToggle,
  onPinConv,
  onFavConv,
  onDeleteConv,
  onMuteConv,
  onArchiveConv,
  onToggleReadConv,
  onBulkDeleteConversations,
  onNewGroup,
  searchInputRef,
}: ChatSidebarProps) {
  const { hasFeature } = useFeatures() as any;
  const [sidebarTab, setSidebarTab] = useState("msgs");
  // Signal-style Archived section: archived chats are hidden from the main
  // list and live behind an "Archived (n)" row at the bottom.
  const [showArchived, setShowArchived] = useState(false);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number | string>>(
    new Set(),
  );
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const normalizedSearch = search.trim().toLowerCase();
  const matchesSearch = (c: any) =>
    !normalizedSearch ||
    [getConvName(c), c.other_username, c.last_message, c.group_name]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedSearch);

  // Separate meeting conversations from regular ones and retain them while
  // searching, matching mobile's in-place filtering model.
  const allRegular = conversations.filter((c) => !c.is_meeting_chat);
  const meetingConvs = conversations.filter(
    (c) => c.is_meeting_chat && matchesSearch(c),
  );

  const archivedConvs = allRegular.filter(
    (c) => c.is_archived && matchesSearch(c),
  );
  const regularConvs = allRegular.filter(
    (c) => !c.is_archived && matchesSearch(c),
  );
  // Muted chats don't contribute to the aggregate unread badge (Signal parity)
  const totalUnread = regularConvs.reduce(
    (sum, c) => sum + (c.is_muted ? 0 : c.unread_count || 0),
    0,
  );

  const pinned = regularConvs.filter((c) => c.is_pinned);
  const favourites = regularConvs.filter((c) => c.is_favourite && !c.is_pinned);
  const others = regularConvs.filter((c) => !c.is_pinned && !c.is_favourite);

  const convProps = {
    activeConvId,
    typingUsers,
    onlineUsers,
    userStatusMap,
    convMenu,
    userId,
    onMenuToggle,
    onPin: onPinConv,
    onFav: onFavConv,
    onDelete: onDeleteConv,
    onMute: onMuteConv,
    onArchive: onArchiveConv,
    onToggleRead: onToggleReadConv,
    selectionMode,
    onToggleSelect: (id: number | string) => {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        if (next.size === 0) setSelectionMode(false);
        return next;
      });
    },
    onEnterSelection: (id: number | string) => {
      setSelectionMode(true);
      setSelectedIds(new Set([id]));
      if (convMenu != null) onMenuToggle(convMenu);
    },
  };

  const selectableConversations =
    sidebarTab === "meetings" ? meetingConvs : regularConvs;
  const allSelected =
    selectableConversations.length > 0 &&
    selectedIds.size === selectableConversations.length;
  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setConfirmBulkDelete(false);
  };
  const toggleSelectAll = () => {
    setSelectedIds(
      allSelected
        ? new Set()
        : new Set(
            selectableConversations.map((conversation) => conversation.id),
          ),
    );
    setSelectionMode(!allSelected);
  };
  const performBulkDelete = async () => {
    if (!onBulkDeleteConversations || selectedIds.size === 0) return;
    setDeleting(true);
    try {
      await onBulkDeleteConversations([...selectedIds]);
      exitSelection();
    } finally {
      setDeleting(false);
    }
  };
  const [showSearch, setShowSearch] = useState(false);

  const openSearch = () => {
    setShowSearch(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  };
  const closeSearch = () => {
    setShowSearch(false);
    setSearch("");
  };

  const switchTab = (tab: string) => {
    setSidebarTab(tab);
    setShowSearch(false);
    setSearch("");
    exitSelection();
  };

  return (
    <div
      className={`${s.sidebar} ${mobileView === "chat" ? s.hideMobile : ""}`}
    >
      {selectionMode ? (
        <div className={s.callSelectionBar}>
          <button
            className={s.callIconButton}
            onClick={exitSelection}
            aria-label="Cancel selection"
          >
            <X size={16} />
          </button>
          <strong className={s.callSelectionCount}>
            {selectedIds.size} selected
          </strong>
          <button className={s.callActionButton} onClick={toggleSelectAll}>
            <CheckSquare2 size={15} />
            {allSelected ? "Clear all" : "Select all"}
          </button>
          <button
            className={s.callDeleteButton}
            disabled={selectedIds.size === 0}
            onClick={() => setConfirmBulkDelete(true)}
          >
            <Trash2 size={15} /> Delete
          </button>
        </div>
      ) : null}

      {/* ── Tabs ── */}
      <div className={s.sidebarTabs}>
        <button
          className={`${s.tabBtn} ${sidebarTab === "msgs" ? s.tabActive : ""}`}
          onClick={() => switchTab("msgs")}
        >
          <MessageSquare size={14} /> Chat
          {totalUnread > 0 && (
            <span className={s.totalBadge}>{totalUnread}</span>
          )}
        </button>
        {hasFeature("meetings") && (
          <button
            className={`${s.tabBtn} ${sidebarTab === "meetings" ? s.tabActive : ""}`}
            onClick={() => switchTab("meetings")}
          >
            <Video size={14} /> Meet
            {meetingConvs.some((c) => c.unread_count > 0) && (
              <span className={s.totalBadge}>
                {meetingConvs.reduce(
                  (sum, c) => sum + (c.unread_count || 0),
                  0,
                )}
              </span>
            )}
          </button>
        )}
        <button
          className={`${s.tabBtn} ${sidebarTab === "calls" ? s.tabActive : ""}`}
          onClick={() => switchTab("calls")}
        >
          <Phone size={14} /> Calls
        </button>
      </div>

      {sidebarTab !== "msgs" && (
        <div className={s.searchHeader}>
          <Search className={s.searchIcon} size={14} />
          <input
            ref={searchInputRef}
            type="text"
            placeholder={
              sidebarTab === "calls" ? "Search calls…" : "Search meeting chats…"
            }
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={s.searchInput}
          />
          {search ? (
            <button
              className={s.searchCloseBtn}
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
      )}

      {/* ── Calls tab ── */}
      {sidebarTab === "calls" && <CallsTab userId={userId} query={search} />}

      {/* ── Meetings tab ── */}
      {hasFeature("meetings") && sidebarTab === "meetings" && (
        <div className={s.convList}>
          {meetingConvs.length === 0 ? (
            <div className={s.empty}>
              <Video
                size={32}
                strokeWidth={1.2}
                style={{
                  margin: "0 auto 0.5rem",
                  display: "block",
                  opacity: 0.4,
                }}
              />
              No meeting chats yet
            </div>
          ) : (
            meetingConvs.map((c) => (
              <ConversationItem
                key={c.id}
                conv={c}
                onOpen={onOpenConv}
                {...convProps}
                selected={selectedIds.has(c.id)}
              />
            ))
          )}
        </div>
      )}

      {/* ── Messages tab ── */}
      {sidebarTab === "msgs" && (
        <>
          {!showSearch ? (
            <div className={s.sidebarHeader}>
              <h2
                style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
              >
                <MessageSquare size={18} /> Messages
              </h2>
              <div className={s.headerBtns}>
                <button
                  className={s.newGroupBtn}
                  onClick={openSearch}
                  title="Search people"
                >
                  <Search size={16} />
                </button>
                <button
                  className={s.newGroupBtn}
                  onClick={onNewGroup}
                  title="New group"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.25rem",
                  }}
                >
                  <Users size={15} />
                  <UserPlus size={13} />
                </button>
              </div>
            </div>
          ) : (
            <div className={s.searchHeader}>
              <svg
                className={s.searchIcon}
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
              >
                <circle
                  cx="6"
                  cy="6"
                  r="4.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M10 10l2.5 2.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search chats and people..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className={s.searchInput}
                autoFocus
              />
              <button className={s.searchCloseBtn} onClick={closeSearch}>
                <X size={16} />
              </button>
            </div>
          )}

          {search.trim().length >= 2 && (
            <div className={s.searchResults}>
              {searching && <div className={s.hint}>Searching...</div>}
              {!searching && searchResults.length === 0 && (
                <div className={s.hint}>No users found</div>
              )}
              {searchResults.map((u) => (
                <div
                  key={u.id}
                  className={s.searchItem}
                  onClick={() => onSearchUser(u)}
                >
                  <ChatAvatar
                    name={u.full_name}
                    avatar={u.avatar}
                    size="md"
                    online={onlineUsers.has(u.id)}
                    userStatus={userStatusMap[u.id]}
                  />
                  <div className={s.userInfo}>
                    <div className={s.userName}>
                      {u.full_name}
                      {u.id === userId ? " (You)" : ""}
                    </div>
                    <div className={s.userMeta}>
                      @{u.username}
                      {u.id === userId
                        ? " · Message yourself"
                        : u.email
                          ? ` · ${u.email}`
                          : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {showArchived && !normalizedSearch ? (
            <div className={s.convList}>
              <div
                className={s.convSection}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  cursor: "pointer",
                }}
                onClick={() => setShowArchived(false)}
              >
                <ChevronLeft size={14} /> <Archive size={13} /> Archived (
                {archivedConvs.length})
              </div>
              {archivedConvs.length === 0 ? (
                <div className={s.empty}>No archived chats</div>
              ) : (
                archivedConvs.map((c) => (
                  <ConversationItem
                    key={c.id}
                    conv={c}
                    onOpen={onOpenConv}
                    {...convProps}
                    selected={selectedIds.has(c.id)}
                  />
                ))
              )}
            </div>
          ) : null}
          {!showArchived && (
            <div className={s.convList}>
              {loadingConvs ? (
                <div className={s.skeletonList}>
                  {[...Array(8)].map((_, i) => (
                    <div key={i} className={s.skeletonItem}>
                      <div className={s.skeletonAvatar} />
                      <div className={s.skeletonText}>
                        <div
                          className={s.skeletonLine}
                          style={{ width: `${55 + (i % 3) * 15}%` }}
                        />
                        <div
                          className={s.skeletonLine}
                          style={{ width: `${35 + (i % 4) * 10}%`, height: 10 }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : regularConvs.length === 0 ? (
                <div className={s.empty}>
                  No conversations yet. Search for a colleague to start
                  chatting.
                </div>
              ) : (
                <>
                  {pinned.length > 0 && (
                    <>
                      <div className={s.convSection}>
                        <Pin
                          size={13}
                          style={{ marginRight: 4, verticalAlign: "middle" }}
                        />
                        Pinned
                      </div>
                      {pinned.map((c) => (
                        <ConversationItem
                          key={c.id}
                          conv={c}
                          onOpen={onOpenConv}
                          {...convProps}
                          selected={selectedIds.has(c.id)}
                        />
                      ))}
                    </>
                  )}
                  {favourites.length > 0 && (
                    <>
                      <div className={s.convSection}>
                        <Star
                          size={13}
                          style={{ marginRight: 4, verticalAlign: "middle" }}
                        />
                        Favourites
                      </div>
                      {favourites.map((c) => (
                        <ConversationItem
                          key={c.id}
                          conv={c}
                          onOpen={onOpenConv}
                          {...convProps}
                          selected={selectedIds.has(c.id)}
                        />
                      ))}
                    </>
                  )}
                  {(pinned.length > 0 || favourites.length > 0) &&
                    others.length > 0 && (
                      <div className={s.convSection}>
                        <MessageSquare
                          size={13}
                          style={{ marginRight: 4, verticalAlign: "middle" }}
                        />
                        All Messages
                      </div>
                    )}
                  {others.map((c) => (
                    <ConversationItem
                      key={c.id}
                      conv={c}
                      onOpen={onOpenConv}
                      {...convProps}
                      selected={selectedIds.has(c.id)}
                    />
                  ))}
                  {archivedConvs.length > 0 && (
                    <div
                      className={s.convSection}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.35rem",
                        cursor: "pointer",
                        marginTop: "0.5rem",
                      }}
                      onClick={() => setShowArchived(true)}
                      title="Show archived chats"
                    >
                      <Archive size={13} /> Archived ({archivedConvs.length})
                    </div>
                  )}
                </>
              )}

              <ConfirmDialog
                isOpen={confirmBulkDelete}
                title="Delete selected conversations?"
                message={`Delete ${selectedIds.size} conversation${selectedIds.size === 1 ? "" : "s"}? This cannot be undone.`}
                confirmText={deleting ? "Deleting…" : "Delete"}
                onConfirm={performBulkDelete}
                onCancel={() => !deleting && setConfirmBulkDelete(false)}
                isDanger
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
