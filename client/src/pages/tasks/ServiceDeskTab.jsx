import React, { useState, useEffect, useCallback } from 'react';
import { Bug, Sparkles, ShieldAlert, HelpCircle, Plus, X, Send, ChevronDown, ChevronUp } from 'lucide-react';
import { getServiceDeskTickets, createServiceDeskTicket, getServiceDeskStats } from '../../api';
import s from './ServiceDeskTab.module.css';

const TICKET_TYPES = [
  { value: 'bug', label: 'Bug Report', icon: <Bug size={14} />, color: '#ef4444' },
  { value: 'feature_request', label: 'Feature Request', icon: <Sparkles size={14} />, color: '#8b5cf6' },
  { value: 'access_issue', label: 'Access Issue', icon: <ShieldAlert size={14} />, color: '#f59e0b' },
  { value: 'other', label: 'Other', icon: <HelpCircle size={14} />, color: '#6b7280' },
];

const PRIORITIES = [
  { value: 'low', label: 'Low', color: '#22c55e' },
  { value: 'medium', label: 'Medium', color: '#f59e0b' },
  { value: 'high', label: 'High', color: '#ef4444' },
  { value: 'critical', label: 'Critical', color: '#dc2626' },
];

const STATUSES = [
  { value: 'open', label: 'Open', color: '#3b82f6' },
  { value: 'acknowledged', label: 'Acknowledged', color: '#8b5cf6' },
  { value: 'in_progress', label: 'In Progress', color: '#f59e0b' },
  { value: 'resolved', label: 'Resolved', color: '#22c55e' },
  { value: 'closed', label: 'Closed', color: '#6b7280' },
];

function getTicketType(type) {
  return TICKET_TYPES.find((t) => t.value === type) || TICKET_TYPES[3];
}
function getPriority(p) {
  return PRIORITIES.find((pr) => pr.value === p) || PRIORITIES[1];
}
function getStatus(st) {
  return STATUSES.find((s) => s.value === st) || STATUSES[0];
}

export default function ServiceDeskTab() {
  const [tickets, setTickets] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType, setFilterType] = useState('');
  const [expandedTicket, setExpandedTicket] = useState(null);

  // Form fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [ticketType, setTicketType] = useState('bug');
  const [priority, setPriority] = useState('medium');

  const fetchTickets = useCallback(async () => {
    try {
      setLoading(true);
      const params = {};
      if (filterStatus) params.status = filterStatus;
      if (filterType) params.ticket_type = filterType;
      const res = await getServiceDeskTickets(params);
      setTickets(res.data.tickets);
    } catch {
      setError('Failed to load tickets');
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterType]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await getServiceDeskStats();
      setStats(res.data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchTickets();
    fetchStats();
  }, [fetchTickets, fetchStats]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await createServiceDeskTicket({
        title: title.trim(),
        description: description.trim(),
        ticket_type: ticketType,
        priority,
      });
      setTitle('');
      setDescription('');
      setTicketType('bug');
      setPriority('medium');
      setFormOpen(false);
      fetchTickets();
      fetchStats();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to submit ticket');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={s['service-desk']}>
      {error && <div className="error-msg error-msg-mb">{error}</div>}

      {/* Stats Bar */}
      {stats && (
        <div className={s['stats-bar']}>
          <button
            type="button"
            className={`${s['stat-chip']} ${!filterStatus ? s['stat-active'] : ''}`}
            onClick={() => setFilterStatus('')}
          >
            <span className={s['stat-value']}>{stats.total}</span>
            <span className={s['stat-label']}>Total</span>
          </button>
          {STATUSES.filter((st) => stats[st.value] > 0 || st.value === 'open').map((st) => (
            <button
              key={st.value}
              type="button"
              className={`${s['stat-chip']} ${filterStatus === st.value ? s['stat-active'] : ''}`}
              style={{ '--chip-color': st.color }}
              onClick={() => setFilterStatus((prev) => (prev === st.value ? '' : st.value))}
            >
              <span className={s['stat-value']}>{stats[st.value] || 0}</span>
              <span className={s['stat-label']}>{st.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className={s['toolbar']}>
        <div className={s['filter-row']}>
          <select
            className={s['filter-select']}
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="">All Types</option>
            {TICKET_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <button
          className={`btn btn-primary ${s['new-ticket-btn']}`}
          onClick={() => setFormOpen((o) => !o)}
        >
          {formOpen ? <><X size={14} /> Cancel</> : <><Plus size={14} /> New Ticket</>}
        </button>
      </div>

      {/* New Ticket Form */}
      {formOpen && (
        <form className={s['ticket-form']} onSubmit={handleSubmit}>
          <div className={s['form-row']}>
            <div className={s['form-group']} style={{ flex: 2 }}>
              <label>Title *</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Brief description of the issue or request..."
                maxLength={200}
                required
                className={s['form-input']}
              />
            </div>
            <div className={s['form-group']}>
              <label>Type</label>
              <select
                value={ticketType}
                onChange={(e) => setTicketType(e.target.value)}
                className={s['form-select']}
              >
                {TICKET_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className={s['form-group']}>
              <label>Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className={s['form-select']}
              >
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className={s['form-group']}>
            <label>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Provide details: steps to reproduce (for bugs), expected behavior, screenshots info, etc."
              maxLength={5000}
              rows={4}
              className={s['form-textarea']}
            />
          </div>
          <div className={s['form-actions']}>
            <button type="submit" className="btn btn-primary" disabled={submitting || !title.trim()}>
              <Send size={14} /> {submitting ? 'Submitting...' : 'Submit Ticket'}
            </button>
          </div>
        </form>
      )}

      {/* Tickets List */}
      {loading ? (
        <div className="loading-spinner"><div className="spinner" /></div>
      ) : tickets.length === 0 ? (
        <div className={s['empty-state']}>
          <div className={s['empty-icon']}>🎫</div>
          <p>No tickets found</p>
          <span>Submit a ticket to report bugs, request features, or get help with access issues.</span>
        </div>
      ) : (
        <div className={s['tickets-list']}>
          {tickets.map((ticket) => {
            const type = getTicketType(ticket.ticket_type);
            const pri = getPriority(ticket.priority);
            const st = getStatus(ticket.status);
            const isExpanded = expandedTicket === ticket.id;
            return (
              <div key={ticket.id} className={s['ticket-card']}>
                <div
                  className={s['ticket-header']}
                  onClick={() => setExpandedTicket(isExpanded ? null : ticket.id)}
                >
                  <div className={s['ticket-left']}>
                    <span className={s['ticket-type-badge']} style={{ '--type-color': type.color }}>
                      {type.icon} {type.label}
                    </span>
                    <span className={s['ticket-title']}>{ticket.title}</span>
                  </div>
                  <div className={s['ticket-right']}>
                    <span className={s['ticket-priority']} style={{ color: pri.color }}>
                      {pri.label}
                    </span>
                    <span className={s['ticket-status-badge']} style={{ '--status-color': st.color }}>
                      {st.label}
                    </span>
                    <span className={s['ticket-date']}>
                      {new Date(ticket.created_at).toLocaleDateString()}
                    </span>
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </div>
                </div>
                {isExpanded && (
                  <div className={s['ticket-details']}>
                    {ticket.description && (
                      <div className={s['ticket-desc']}>{ticket.description}</div>
                    )}
                    <div className={s['ticket-meta']}>
                      <span>Submitted by: <strong>{ticket.submitted_by_name}</strong></span>
                      {ticket.tenant_name && <span>Organization: <strong>{ticket.tenant_name}</strong></span>}
                      {ticket.assigned_to && <span>Assigned to: <strong>{ticket.assigned_to}</strong></span>}
                      {ticket.admin_notes && (
                        <div className={s['admin-notes']}>
                          <strong>Admin Notes:</strong> {ticket.admin_notes}
                        </div>
                      )}
                      {ticket.resolved_at && (
                        <span>Resolved: {new Date(ticket.resolved_at).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
