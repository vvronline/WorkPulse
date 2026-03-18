import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { getConversations } from './api';
import { useAuth } from './AuthContext';

const ChatCtx = createContext({ unreadCount: 0, refreshUnread: () => {} });

export function ChatProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);

  const refreshUnread = useCallback(async () => {
    if (!isAuthenticated) { setUnreadCount(0); return; }
    try {
      const { data } = await getConversations();
      setUnreadCount(data.reduce((sum, c) => sum + (c.unread_count || 0), 0));
    } catch { /* ignore */ }
  }, [isAuthenticated]);

  useEffect(() => { refreshUnread(); }, [refreshUnread]);

  const value = useMemo(() => ({ unreadCount, refreshUnread }), [unreadCount, refreshUnread]);

  return (
    <ChatCtx.Provider value={value}>
      {children}
    </ChatCtx.Provider>
  );
}

export const useChatUnread = () => useContext(ChatCtx);
