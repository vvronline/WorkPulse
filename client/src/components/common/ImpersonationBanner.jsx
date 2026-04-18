import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ShieldAlert, LogOut, Eye, Clock, FileText, Edit3, X, ChevronDown, ChevronUp } from 'lucide-react';
import { exitImpersonation, getImpersonationSession } from '../../api';
import { useAuth } from '../../AuthContext';
import s from './ImpersonationBanner.module.css';

function formatElapsed(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function SessionSummaryModal({ summary, onClose, onConfirmExit, exiting }) {
  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.modal} onClick={e => e.stopPropagation()}>
        <div className={s.modalHeader}>
          <ShieldAlert size={18} />
          <span>Impersonation Session Summary</span>
          <button className={s.modalCloseBtn} onClick={onClose}><X size={16} /></button>
        </div>

        <div className={s.modalBody}>
          <div className={s.summaryStats}>
            <div className={s.summaryStat}>
              <div className={s.summaryStatValue}>{summary.total}</div>
              <div className={s.summaryStatLabel}>Total Actions</div>
            </div>
            <div className={s.summaryStat}>
              <div className={s.summaryStatValue} style={{ color: 'var(--info, #3b82f6)' }}>{summary.reads}</div>
              <div className={s.summaryStatLabel}>Inspections</div>
            </div>
            <div className={s.summaryStat}>
              <div className={s.summaryStatValue} style={{ color: 'var(--warning, #f59e0b)' }}>{summary.writes}</div>
              <div className={s.summaryStatLabel}>Modifications</div>
            </div>
          </div>

          {summary.actions.length > 0 && (
            <div className={s.actionLog}>
              <div className={s.actionLogTitle}>Action Log</div>
              <div className={s.actionLogList}>
                {summary.actions.map((a, i) => (
                  <div key={i} className={s.actionLogItem}>
                    <span className={`${s.actionMethod} ${a.type === 'write' ? s.methodWrite : s.methodRead}`}>
                      {a.method || (a.type === 'write' ? 'WRITE' : 'READ')}
                    </span>
                    <span className={s.actionPath}>{a.path}</span>
                    <span className={s.actionTime}>
                      {new Date(a.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {summary.actions.length === 0 && (
            <div className={s.noActions}>No actions were recorded during this session.</div>
          )}
        </div>

        <div className={s.modalFooter}>
          <button className={s.cancelBtn} onClick={onClose}>Continue Inspecting</button>
          <button className={s.confirmExitBtn} onClick={onConfirmExit} disabled={exiting}>
            <LogOut size={14} />
            {exiting ? 'Ending Session…' : 'End Session & Exit'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ImpersonationBanner() {
  const { user } = useAuth();
  const [exiting, setExiting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sessionInfo, setSessionInfo] = useState({ total: 0, reads: 0, writes: 0, actions: [] });
  const [showSummary, setShowSummary] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const startTimeRef = useRef(Date.now());
  const pollRef = useRef(null);

  // Elapsed timer
  useEffect(() => {
    if (!user?.impersonated) return;
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [user?.impersonated]);

  // Poll session actions every 15s
  const fetchSession = useCallback(async () => {
    if (!user?.impersonated || !user?.tenant_id) return;
    try {
      const { data } = await getImpersonationSession(user.tenant_id);
      setSessionInfo(data);
      if (data.session_start) {
        startTimeRef.current = new Date(data.session_start).getTime();
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    } catch { /* silent */ }
  }, [user?.impersonated, user?.tenant_id]);

  useEffect(() => {
    if (!user?.impersonated) return;
    fetchSession();
    pollRef.current = setInterval(fetchSession, 15000);
    return () => clearInterval(pollRef.current);
  }, [user?.impersonated, fetchSession]);

  if (!user?.impersonated) return null;

  const handleExitClick = async () => {
    // Fetch latest session info before showing summary
    await fetchSession();
    setShowSummary(true);
  };

  const handleConfirmExit = async () => {
    setExiting(true);
    try {
      await exitImpersonation(user.tenant_id);
      // Server restores the original platform admin cookie (HttpOnly)
      window.location.href = '/tenants';
    } catch {
      setExiting(false);
    }
  };

  return (
    <>
      <div className={s.banner}>
        <div className={s.bannerMain}>
          <div className={s.recordingIndicator}>
            <span className={s.recordingDot} />
            <span className={s.recordingText}>MONITORED</span>
          </div>

          <div className={s.divider} />

          <ShieldAlert size={15} />
          <span className={s.text}>
            Inspecting <span className={s.tenantName}>{user.impersonated_tenant_name || user.tenant_id}</span>
            {' '}as {user.full_name || user.username}
          </span>

          <div className={s.divider} />

          <div className={s.stats}>
            <span className={s.stat} title="Session duration">
              <Clock size={13} /> {formatElapsed(elapsed)}
            </span>
            <span className={s.stat} title="Pages inspected">
              <Eye size={13} /> {sessionInfo.reads}
            </span>
            <span className={s.stat} title="Actions taken">
              <Edit3 size={13} /> {sessionInfo.writes}
            </span>
          </div>

          <button className={s.detailToggle} onClick={() => setExpanded(v => !v)} title="Toggle action details">
            <FileText size={13} />
            {sessionInfo.total} actions
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>

          <button className={s.exitBtn} onClick={handleExitClick} disabled={exiting}>
            <LogOut size={13} />
            {exiting ? 'Exiting…' : 'Exit Tenant'}
          </button>
        </div>

        {expanded && sessionInfo.actions.length > 0 && (
          <div className={s.expandedLog}>
            {sessionInfo.actions.slice(-10).map((a, i) => (
              <div key={i} className={s.miniLogItem}>
                <span className={`${s.miniMethod} ${a.type === 'write' ? s.methodWrite : s.methodRead}`}>
                  {a.method}
                </span>
                <span className={s.miniPath}>{a.path}</span>
                <span className={s.miniTime}>{new Date(a.timestamp).toLocaleTimeString()}</span>
              </div>
            ))}
            {sessionInfo.actions.length > 10 && (
              <div className={s.moreActions}>… and {sessionInfo.actions.length - 10} more</div>
            )}
          </div>
        )}
      </div>

      {showSummary && (
        <SessionSummaryModal
          summary={sessionInfo}
          onClose={() => setShowSummary(false)}
          onConfirmExit={handleConfirmExit}
          exiting={exiting}
        />
      )}
    </>
  );
}
