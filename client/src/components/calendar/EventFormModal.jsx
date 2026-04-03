import React, { useState, useEffect, useRef } from 'react';
import { searchChatUsers } from '../../api';
import s from './Calendar.module.css';

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6'];

function pad(n) { return String(n).padStart(2, '0'); }

const TIME_OPTIONS = [];
for (let h = 0; h < 24; h++) {
  for (let m = 0; m < 60; m += 15) {
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    TIME_OPTIONS.push({ value: `${pad(h)}:${pad(m)}`, label: `${h12}:${pad(m)} ${ampm}` });
  }
}

function getDatePart(iso) { return iso ? iso.slice(0, 10) : ''; }
function getTimePart(iso) { return iso ? iso.slice(11, 16) : ''; }
function combineDatetime(date, time) { return date && time ? `${date}T${time}` : ''; }
function getTimeOptions(timePart) {
  if (!timePart) return TIME_OPTIONS;
  const [, m] = timePart.split(':').map(Number);
  if (m % 15 === 0) return TIME_OPTIONS;
  const [h2] = timePart.split(':').map(Number);
  const ampm = h2 < 12 ? 'AM' : 'PM';
  const h12 = h2 === 0 ? 12 : h2 > 12 ? h2 - 12 : h2;
  const extra = { value: timePart, label: `${h12}:${pad(m)} ${ampm}` };
  return [...TIME_OPTIONS.filter(o => o.value < timePart), extra, ...TIME_OPTIONS.filter(o => o.value > timePart)];
}

/**
 * Modal for creating or editing a calendar event.
 *
 * Props:
 *   modal        – event id (string/number) when editing, 'create' when new, null to hide
 *   form         – form state object
 *   setForm      – form state setter
 *   nowMin       – ISO local datetime string for min-date validation on new events
 *   tasks        – array of linkable tasks
 *   onSave       – async (meetingOptions?: {participants,settings}) => void
 *   onDelete     – async () => void
 *   onClose      – () => void
 *   onStartChange – (val: string) => void — handles start time changes with end-time adjustment
 *   existingMeetingCode – meeting_code if editing an event that has a meeting
 */
function MeetingParticipantPicker({ participants, onChange }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const timerRef = useRef(null);

    useEffect(() => {
        if (query.trim().length < 2) { setResults([]); return; }
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(async () => {
            setLoading(true);
            try {
                const r = await searchChatUsers(query.trim());
                setResults((r.data || []).filter(u => !participants.some(p => p.id === u.id)));
            } catch { setResults([]); }
            finally { setLoading(false); }
        }, 300);
        return () => clearTimeout(timerRef.current);
    }, [query, participants]);

    const add = (user) => {
        onChange([...participants, user]);
        setQuery('');
        setResults([]);
    };
    const remove = (id) => onChange(participants.filter(p => p.id !== id));

    return (
        <div className={s.participantPicker}>
            <div className={s.participantChips}>
                {participants.map(p => (
                    <span key={p.id} className={s.participantChip}>
                        {p.name || p.full_name || p.username}
                        <button type="button" onClick={() => remove(p.id)}>×</button>
                    </span>
                ))}
            </div>
            <div className={s.participantSearch}>
                <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Search people to invite…"
                    className={s.participantInput}
                />
                {loading && <span className={s.participantLoading}>…</span>}
                {results.length > 0 && (
                    <ul className={s.participantResults}>
                        {results.map(u => (
                            <li key={u.id} onClick={() => add(u)}>
                                {u.name || u.full_name || u.username}
                                {u.email && <span className={s.participantEmail}> — {u.email}</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

export default function EventFormModal({ modal, form, setForm, nowMin, tasks, onSave, onDelete, onClose, onStartChange, existingMeetingCode }) {
    const [addMeeting, setAddMeeting] = useState(false);
    const [meetingParticipants, setMeetingParticipants] = useState([]);
    const [meetingSettings, setMeetingSettings] = useState({ muteOnJoin: false, allowScreenShare: true });

    // Reset meeting state when modal opens/closes
    useEffect(() => {
        if (modal === null) {
            setAddMeeting(false);
            setMeetingParticipants([]);
            setMeetingSettings({ muteOnJoin: false, allowScreenShare: true });
        }
    }, [modal]);

    if (modal === null) return null;

    const isEditing = modal !== 'create';
    const hasMeeting = isEditing && !!existingMeetingCode;

    const handleSave = () => {
        if (addMeeting && !isEditing) {
            onSave({ participants: meetingParticipants, settings: meetingSettings });
        } else {
            onSave(null);
        }
    };

    return (
    <div className={s.modalOverlay} onClick={onClose}>
      <div className={s.modal} onClick={e => e.stopPropagation()}>
        <h3>{modal === 'create' ? 'New Event' : 'Edit Event'}</h3>

        <div className={s.formGroup}>
          <label>Title</label>
          <input
            value={form.title}
            onChange={e => setForm({ ...form, title: e.target.value })}
            placeholder="Event title"
            autoFocus
          />
        </div>

        <div className={s.formGroup}>
          <label>Description</label>
          <textarea
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            placeholder="Optional description"
            rows={2}
          />
        </div>

        <div className={s.formRow}>
          <div className={s.formGroup}>
            <label>Start</label>
            {form.all_day ? (
              <input
                type="date"
                value={getDatePart(form.start_time)}
                min={modal === 'create' ? getDatePart(nowMin) : undefined}
                onChange={e => onStartChange(combineDatetime(e.target.value, '00:00'))}
              />
            ) : (
              <div className={s.datetimePicker}>
                <input
                  type="date"
                  value={getDatePart(form.start_time)}
                  min={modal === 'create' ? getDatePart(nowMin) : undefined}
                  onChange={e => onStartChange(combineDatetime(e.target.value, getTimePart(form.start_time)))}
                />
                <select
                  value={getTimePart(form.start_time)}
                  onChange={e => onStartChange(combineDatetime(getDatePart(form.start_time), e.target.value))}
                >
                  {getTimeOptions(getTimePart(form.start_time)).map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className={s.formGroup}>
            <label>End</label>
            {form.all_day ? (
              <input
                type="date"
                value={getDatePart(form.end_time)}
                min={getDatePart(form.start_time)}
                onChange={e => setForm({ ...form, end_time: combineDatetime(e.target.value, '00:00') })}
              />
            ) : (
              <div className={s.datetimePicker}>
                <input
                  type="date"
                  value={getDatePart(form.end_time)}
                  min={getDatePart(form.start_time)}
                  onChange={e => setForm({ ...form, end_time: combineDatetime(e.target.value, getTimePart(form.end_time)) })}
                />
                <select
                  value={getTimePart(form.end_time)}
                  onChange={e => setForm({ ...form, end_time: combineDatetime(getDatePart(form.end_time), e.target.value) })}
                >
                  {getTimeOptions(getTimePart(form.end_time)).map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        <div className={s.formRow}>
          <div className={s.formGroup}>
            <label>Color</label>
            <div className={s.colorPicker}>
              {COLORS.map(c => (
                <button
                  key={c}
                  className={`${s.colorDot} ${form.color === c ? s.colorDotActive : ''}`}
                  style={{ background: c }}
                  onClick={() => setForm({ ...form, color: c })}
                />
              ))}
            </div>
          </div>
          <label className={s.checkbox}>
            <input
              type="checkbox"
              checked={form.all_day}
              onChange={e => setForm({ ...form, all_day: e.target.checked })}
            />
            All day
          </label>
        </div>

        {tasks.length > 0 && (
          <div className={s.formGroup}>
            <label>Link to Task</label>
            <select value={form.task_id} onChange={e => setForm({ ...form, task_id: e.target.value })}>
              <option value="">None</option>
              {tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </div>
        )}

        {/* Meeting section */}
        {hasMeeting ? (
          <div className={s.meetingBanner}>
            <span className={s.meetingIcon}>📹</span>
            <span>Online meeting</span>
            <a
              href={`${window.location.origin}/meeting/${existingMeetingCode}`}
              target="_blank"
              rel="noopener noreferrer"
              className={s.meetingLink}
            >
              {`${window.location.origin}/meeting/${existingMeetingCode}`}
            </a>
            <a
              href={`/meeting/${existingMeetingCode}`}
              className={s.joinMeetingBtn}
              onClick={e => { e.preventDefault(); onClose(); window.location.href = `/meeting/${existingMeetingCode}`; }}
            >
              Join
            </a>
          </div>
        ) : modal === 'create' && (
          <div className={s.meetingToggleRow}>
            <label className={s.toggleLabel}>
              <span className={s.meetingIcon}>📹</span>
              Add online meeting
            </label>
            <button
              type="button"
              className={`${s.toggleSwitch} ${addMeeting ? s.toggleSwitchOn : ''}`}
              onClick={() => setAddMeeting(v => !v)}
              aria-pressed={addMeeting}
            >
              <span className={s.toggleThumb} />
            </button>
          </div>
        )}

        {modal === 'create' && addMeeting && (
          <div className={s.meetingOptions}>
            <div className={s.formGroup}>
              <label>Invite participants</label>
              <MeetingParticipantPicker
                participants={meetingParticipants}
                onChange={setMeetingParticipants}
              />
            </div>
            <div className={s.meetingSettingsRow}>
              <label className={s.checkbox}>
                <input
                  type="checkbox"
                  checked={meetingSettings.muteOnJoin}
                  onChange={e => setMeetingSettings(p => ({ ...p, muteOnJoin: e.target.checked }))}
                />
                Mute participants on join
              </label>
              <label className={s.checkbox}>
                <input
                  type="checkbox"
                  checked={meetingSettings.allowScreenShare}
                  onChange={e => setMeetingSettings(p => ({ ...p, allowScreenShare: e.target.checked }))}
                />
                Allow screen sharing
              </label>
            </div>
          </div>
        )}

        <div className={s.formActions}>
          {modal !== 'create' && (
            <button className={s.deleteBtn} onClick={onDelete}>Delete</button>
          )}
          <div className={s.formActionsRight}>
            <button className={s.cancelBtn} onClick={onClose}>Cancel</button>
            <button className={s.saveBtn} onClick={handleSave}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
