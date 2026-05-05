import React, { memo, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Inbox } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import useWebSocket from '../../hooks/useWebSocket';
import { getActiveSprint, getSprintTasks, getBacklog } from '../../api';
import s from './SprintProgressCard.module.css';

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

const SprintProgressCard = memo(function SprintProgressCard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [sprint, setSprint] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [backlogTasks, setBacklogTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [noSprint, setNoSprint] = useState(false);
  const cancelledRef = useRef(false);

  const loadCard = useCallback(async () => {
    try {
      const { data } = await getActiveSprint();
      if (cancelledRef.current) return;
      if (!data.sprint) {
        setNoSprint(true);
        setSprint(null);
        // Fetch backlog tasks assigned to current user
        try {
          const blRes = await getBacklog({ assignee: 'me' });
          if (!cancelledRef.current) {
            const myBacklog = (blRes.data.tasks || [])
              .filter(t => t.status !== 'done')
              .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3))
              .slice(0, 5);
            setBacklogTasks(myBacklog);
          }
        } catch { /* silent */ }
        return;
      }
      setNoSprint(false);
      setSprint(data.sprint);
      const taskRes = await getSprintTasks(data.sprint.id);
      if (!cancelledRef.current) setTasks(taskRes.data.tasks || []);
    } catch {
      if (!cancelledRef.current) setNoSprint(true);
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    loadCard();
    return () => { cancelledRef.current = true; };
  }, [loadCard]);

  // Refresh when the window regains focus or becomes visible — covers the case
  // where the user reassigns a ticket in another tab/page and returns here.
  useEffect(() => {
    const onFocus = () => { loadCard(); };
    const onVisibility = () => { if (!document.hidden) loadCard(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadCard]);

  // Refresh on real-time task assignment events broadcast over WebSocket.
  useWebSocket(useCallback((msg) => {
    if (msg.type === 'task_assigned' || msg.type === 'task_updated') {
      loadCard();
    }
  }, [loadCard]));

  if (loading) {
    return (
      <div className={`status-card ${s.card}`}>
        <div className={s.skeleton} />
      </div>
    );
  }

  // No active sprint — show backlog tasks assigned to user
  if (noSprint) {
    return (
      <div
        className={`status-card ${s.card} ${s.clickable}`}
        onClick={() => navigate('/tasks')}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && navigate('/tasks')}
      >
        <h3 className={s.title}>
          <span className="page-icon"><Inbox size={18} /></span> Backlog
          {backlogTasks.length > 0 && <span className={s['backlog-count']}>{backlogTasks.length}</span>}
          <span className={s.arrow}>›</span>
        </h3>
        {backlogTasks.length === 0 ? (
          <p className={s['no-sprint-text']}>No backlog tickets assigned to you.</p>
        ) : (
          <div className={s['backlog-list']}>
            {backlogTasks.map(t => (
              <div key={t.id} className={s['backlog-item']}>
                <span className={`${s['backlog-priority']} ${s[`p-${t.priority}`]}`} />
                <span className={s['backlog-title']}>{t.title}</span>
                <span className={`${s['backlog-status']} ${s[`s-${t.status}`]}`}>
                  {t.status === 'in_progress' ? 'In Progress' : t.status === 'in_review' ? 'Review' : 'Pending'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Calculate sprint timeline
  const start = new Date(sprint.start_date);
  const end = new Date(sprint.end_date);
  const now = new Date();
  const totalDays = Math.max(1, Math.ceil((end - start) / 86400000));
  const elapsedDays = Math.min(totalDays, Math.max(0, Math.ceil((now - start) / 86400000)));
  const timelinePercent = Math.min(100, (elapsedDays / totalDays) * 100);

  // Task stats
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const completionPercent = total > 0 ? Math.round((done / total) * 100) : 0;

  // User's assigned tasks
  const myTasks = tasks.filter(t => t.assigned_to === user?.id);
  const myDone = myTasks.filter(t => t.status === 'done').length;

  return (
    <div
      className={`status-card ${s.card} ${s.clickable}`}
      onClick={() => navigate('/sprints')}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && navigate('/sprints')}
    >
      <h3 className={s.title}>
        <span className="page-icon"><Zap size={18} /></span> {sprint.name}
        <span className={s.arrow}>›</span>
      </h3>

      {/* Timeline bar */}
      <div className={s['timeline-section']}>
        <div className={s['timeline-label']}>
          <span>Day {elapsedDays} of {totalDays}</span>
          <span className={s['timeline-pct']}>{Math.round(timelinePercent)}%</span>
        </div>
        <div className={s['timeline-bar']}>
          <div className={s['timeline-fill']} style={{ width: `${timelinePercent}%` }} />
        </div>
      </div>

      {/* Completion stats */}
      <div className={s['stats-row']}>
        <div className={s.stat}>
          <span className={s['stat-num']}>{done}/{total}</span>
          <span className={s['stat-label']}>Tasks Done</span>
        </div>
        <div className={s.stat}>
          <span className={s['stat-num']}>{completionPercent}%</span>
          <span className={s['stat-label']}>Complete</span>
        </div>
        <div className={s.stat}>
          <span className={`${s['stat-num']} ${s['my-count']}`}>{myDone}/{myTasks.length}</span>
          <span className={s['stat-label']}>My Tasks</span>
        </div>
      </div>

      {/* Completion bar */}
      <div className={s['completion-bar']}>
        <div className={s['completion-fill']} style={{ width: `${completionPercent}%` }} />
      </div>
    </div>
  );
});

export default SprintProgressCard;
