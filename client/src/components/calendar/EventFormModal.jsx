import React from 'react';
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
 *   onSave       – async () => void
 *   onDelete     – async () => void
 *   onClose      – () => void
 *   onStartChange – (val: string) => void — handles start time changes with end-time adjustment
 */
export default function EventFormModal({ modal, form, setForm, nowMin, tasks, onSave, onDelete, onClose, onStartChange }) {
  if (modal === null) return null;

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

        <div className={s.formActions}>
          {modal !== 'create' && (
            <button className={s.deleteBtn} onClick={onDelete}>Delete</button>
          )}
          <div className={s.formActionsRight}>
            <button className={s.cancelBtn} onClick={onClose}>Cancel</button>
            <button className={s.saveBtn} onClick={onSave}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
