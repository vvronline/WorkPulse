import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getNotifications, markNotificationRead, markAllNotificationsRead, deleteNotification } from '../api';

const POLL_INTERVAL = 30_000;

function timeAgo(dateStr) {
  // SQLite CURRENT_TIMESTAMP is UTC but has no 'Z'; append it so JS parses correctly
  const utc = dateStr && !dateStr.endsWith('Z') ? dateStr + 'Z' : dateStr;
  const diff = (Date.now() - new Date(utc).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const TYPE_ICON = { mention: '@' };
const DEFAULT_ICON = '🔔';

export default function NotificationBell() {
  const [notifications, setNotifications] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const navigate = useNavigate();

  const fetchNotifs = useCallback(async () => {
    try {
      const res = await getNotifications();
      setNotifications(res.data.notifications);
      setUnread(res.data.unread);
    } catch { /* ignore polling errors */ }
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    fetchNotifs();
    const id = setInterval(fetchNotifs, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchNotifs]);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleOpen = () => {
    setOpen(prev => !prev);
    if (!open) fetchNotifs(); // refresh on open
  };

  const handleMarkAll = async () => {
    try {
      await markAllNotificationsRead();
      setNotifications(prev => prev.map(n => ({ ...n, is_read: 1 })));
      setUnread(0);
    } catch { /* ignore */ }
  };

  const handleClick = async (notif) => {
    setOpen(false);
    if (!notif.is_read) {
      try {
        await markNotificationRead(notif.id);
        setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, is_read: 1 } : n));
        setUnread(prev => Math.max(0, prev - 1));
      } catch { /* ignore */ }
    }
    if (notif.link_task_id) {
      navigate(`/tasks?task=${notif.link_task_id}`);
    }
  };

  const handleDelete = async (e, notifId) => {
    e.stopPropagation();
    try {
      await deleteNotification(notifId);
      setNotifications(prev => {
        const removed = prev.find(n => n.id === notifId);
        if (removed && !removed.is_read) setUnread(u => Math.max(0, u - 1));
        return prev.filter(n => n.id !== notifId);
      });
    } catch { /* ignore */ }
  };

  return (
    <div className="notif-bell-wrapper" ref={wrapperRef}>
      <button
        className="notif-bell-btn"
        onClick={handleOpen}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        title="Notifications"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
        {unread > 0 && (
          <span className="notif-badge">{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div className="notif-dropdown">
          <div className="notif-header">
            <span className="notif-header-title">Notifications</span>
            {unread > 0 && (
              <button className="notif-mark-all" onClick={handleMarkAll}>Mark all read</button>
            )}
          </div>
          <div className="notif-list">
            {notifications.length === 0 ? (
              <div className="notif-empty">No notifications yet</div>
            ) : (
              notifications.map(n => (
                <div
                  key={n.id}
                  className={`notif-item${n.is_read ? '' : ' unread'}`}
                  onClick={() => handleClick(n)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter') handleClick(n); }}
                >
                  <span className="notif-icon">{TYPE_ICON[n.type] || DEFAULT_ICON}</span>
                  <div className="notif-body">
                    <div className="notif-title">{n.title}</div>
                    {n.body && <div className="notif-text">{n.body}</div>}
                    <div className="notif-time">{timeAgo(n.created_at)}</div>
                  </div>
                  <button
                    className="notif-delete"
                    onClick={e => handleDelete(e, n.id)}
                    title="Dismiss"
                    aria-label="Dismiss notification"
                  >✕</button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
