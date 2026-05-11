import React from 'react';
import { PRIORITIES, COLUMNS } from './constants.js';
import { formatDate } from './utils.jsx';
import { getLocalToday } from '../../api';
import { useTaskCtx } from './TaskContext.jsx';
import { CalendarDays, Package, Search, Headset } from 'lucide-react';
import s from './TasksHeader.module.css';

export default function TasksHeader({
  activeTab,
  setActiveTab,
  date,
  setDate,
  isToday,
  selectedSprintId,
  setSelectedSprintId,
  backlogTasks,
  filterCount,
  filtersOpen,
  setFiltersOpen,
  filterAssignee,
  setFilterAssignee,
  filterLabel,
  setFilterLabel,
  filterPriority,
  setFilterPriority,
  filterStatus,
  setFilterStatus,
  filterSearch,
  setFilterSearch,
  globalSearch,
  globalResults,
  globalSearching,
  globalSearchOpen,
  globalSearchRef,
  onGlobalSearch,
  setGlobalSearchOpen,
  onOpenDetail,
  setBacklogFormOpen,
  setSprintImportOpen,
  fetchBacklog,
  clearFilters,
}) {
  const { assignableUsers, orgLabels, availableSprints, currentUser } = useTaskCtx();
  const currentSprint = availableSprints.find((sp) => sp.id === selectedSprintId);
  const teamName = currentUser?.team_name || 'Team';
  const daysLeft = currentSprint
    ? Math.max(
        0,
        Math.ceil(
          (Date.UTC(
            ...currentSprint.end_date.split('-').map((v, i) => (i === 1 ? v - 1 : +v))
          ) -
            Date.UTC(
              ...getLocalToday()
                .split('-')
                .map((v, i) => (i === 1 ? v - 1 : +v))
            )) /
            86400000
        )
      )
    : 0;

  return (
    <>
      {/* Page header */}
      <div className={s['tasks-header']}>
        <div>
          {activeTab === 'sprint' ? (
            <>
              <h2>
                <span className="page-icon">🏃</span> {teamName} —{' '}
                {currentSprint ? currentSprint.name : 'Sprint'}
              </h2>
              <p>
                {currentSprint
                  ? `${currentSprint.start_date} → ${currentSprint.end_date} • ${daysLeft}d remaining`
                  : 'Loading sprint…'}
              </p>
            </>
          ) : (
            <>
              <h2>
                <span className="page-icon">{activeTab === 'service-desk'
                  ? <Headset size={18} style={{verticalAlign:'middle'}} />
                  : <Package size={18} style={{verticalAlign:'middle'}} />
                }</span> {activeTab === 'service-desk' ? 'Service Desk' : 'Backlog'}
              </h2>
              <p>{activeTab === 'service-desk'
                ? 'Report bugs, request features, or raise access issues'
                : 'Unscheduled items waiting to be planned'
              }</p>
            </>
          )}
        </div>

        <div className={s['tasks-header-actions']}>
          {/* Tab switcher */}
          <div className={s['tab-switcher']}>
            {availableSprints.length > 0 && (
              <button
                className={`${s['tab-btn']} ${activeTab === 'sprint' ? s['tab-active'] : ''}`}
                onClick={() => {
                  setActiveTab('sprint');
                  if (!selectedSprintId) {
                    const active = availableSprints.find((sp) => sp.status === 'active');
                    setSelectedSprintId(active ? active.id : (availableSprints[0]?.id ?? null));
                  }
                }}
              >
                Sprint
              </button>
            )}
            <button
              className={`${s['tab-btn']} ${activeTab === 'backlog' ? s['tab-active'] : ''}`}
              onClick={() => setActiveTab('backlog')}
            >
              <Package size={14} style={{verticalAlign:'middle',marginRight:4}} />Backlog{' '}
              {backlogTasks.length > 0 && (
                <span className={s['tab-badge']}>{backlogTasks.length}</span>
              )}
            </button>
            <button
              className={`${s['tab-btn']} ${activeTab === 'service-desk' ? s['tab-active'] : ''}`}
              onClick={() => setActiveTab('service-desk')}
            >
              <Headset size={14} style={{verticalAlign:'middle',marginRight:4}} />Service Desk
            </button>
          </div>

          {/* Sprint select (when multiple sprints) */}
          {activeTab === 'sprint' && availableSprints.length > 1 && (
            <select
              value={selectedSprintId || ''}
              onChange={(e) => setSelectedSprintId(Number(e.target.value))}
              className={s['date-input']}
            >
              {availableSprints.map((sp) => (
                <option key={sp.id} value={sp.id}>
                  {sp.name} {sp.status === 'active' ? '(Active)' : ''}
                </option>
              ))}
            </select>
          )}

          {activeTab !== 'service-desk' && (
            <button
              className={`btn btn-secondary ${s['filter-toggle-btn']} ${filterCount > 0 ? s['has-filters'] : ''}`}
              onClick={() => setFiltersOpen((o) => !o)}
            >
              <Search size={14} style={{verticalAlign:'middle',marginRight:4}} />{filterCount > 0 ? `Filters (${filterCount})` : 'Filters'}
            </button>
          )}

          {activeTab === 'backlog' && (
            <button
              className={`btn btn-secondary ${s['add-task-toggle']}`}
              onClick={() => setBacklogFormOpen((o) => !o)}
            >
              ➕ New Ticket
            </button>
          )}

          {activeTab === 'sprint' && selectedSprintId && (
            <button
              className={`btn btn-secondary ${s['add-task-toggle']} ${s['']}`}
              onClick={() => {
                setSprintImportOpen((o) => !o);
                if (!backlogTasks.length) fetchBacklog();
              }}
            >
              <Package size={14} style={{verticalAlign:'middle',marginRight:4}} />Import from Backlog
            </button>
          )}
        </div>
      </div>

      {/* Global Search */}
      {activeTab !== 'service-desk' && (
      <div className={s['global-search-wrapper']} ref={globalSearchRef}>
        <div className={s['global-search-input-row']}>
          <span className={s['global-search-icon']}><Search size={15} /></span>
          <input
            type="text"
            value={globalSearch}
            onChange={(e) => onGlobalSearch(e.target.value)}
            onFocus={() => {
              if (globalResults.length > 0 || globalSearch.trim().length >= 2)
                setGlobalSearchOpen(true);
            }}
            placeholder="Search all tasks..."
            className={s['global-search-input']}
          />
          {globalSearch && (
            <button
              className={s['global-search-clear']}
              onClick={() => {
                onGlobalSearch('');
                setGlobalSearchOpen(false);
              }}
            >
              ✕
            </button>
          )}
        </div>
        {globalSearchOpen && (
          <div className={s['global-search-results']}>
            {globalSearching ? (
              <div className={s['global-search-status']}>Searching...</div>
            ) : globalResults.length === 0 ? (
              <div className={s['global-search-status']}>No results found</div>
            ) : (
              globalResults.map((task) => {
                const pri = PRIORITIES.find((pr) => pr.value === task.priority) || PRIORITIES[1];
                const colInfo = COLUMNS.find((c) => c.id === task.status) || COLUMNS[0];
                return (
                  <div
                    key={task.id}
                    className={s['global-search-item']}
                    onClick={() => {
                      onOpenDetail(task);
                      setGlobalSearchOpen(false);
                    }}
                  >
                    <div className={s['global-search-item-top']}>
                      <span className={s['backlog-ticket-id']}>#{task.id}</span>
                      <span className={s['global-search-item-title']}>{task.title}</span>
                    </div>
                    <div className={s['global-search-item-meta']}>
                      <span
                        className={s['backlog-status-badge']}
                        style={{
                          '--badge-bg': colInfo.color + '20',
                          '--badge-color': colInfo.color,
                        }}
                      >
                        {colInfo.icon} {colInfo.label}
                      </span>
                      <span
                        className={s['task-priority-badge']}
                        style={{
                          '--badge-bg': pri.color + '20',
                          '--badge-color': pri.color,
                        }}
                      >
                        {pri.icon} {pri.label}
                      </span>
                      {task.date ? (
                        <span className={s['global-search-date']}><CalendarDays size={11} style={{marginRight:3,verticalAlign:'middle'}} />{task.date}</span>
                      ) : (
                        <span className={s['global-search-date']}><Package size={11} style={{marginRight:3,verticalAlign:'middle'}} />Backlog</span>
                      )}
                      {task.labels &&
                        task.labels.map((l) => (
                          <span
                            key={l.id}
                            className={s['label-pill']}
                            style={{ '--label-color': l.color }}
                          >
                            {l.name}
                          </span>
                        ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
      )}

      {/* Filter Bar */}
      {filtersOpen && activeTab !== 'service-desk' && (
        <div className={s['filter-bar']}>
          <div className={s['filter-row']}>
            <div className={s['filter-group']}>
              <label>Assignee</label>
              <select
                value={filterAssignee}
                onChange={(e) => setFilterAssignee(e.target.value)}
                className={s['filter-select']}
              >
                <option value="">All</option>
                <option value="me">My Tasks</option>
                {assignableUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name || u.username}
                  </option>
                ))}
              </select>
            </div>
            <div className={s['filter-group']}>
              <label>Label</label>
              <select
                value={filterLabel}
                onChange={(e) => setFilterLabel(e.target.value)}
                className={s['filter-select']}
              >
                <option value="">All</option>
                {orgLabels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={s['filter-group']}>
              <label>Priority</label>
              <select
                value={filterPriority}
                onChange={(e) => setFilterPriority(e.target.value)}
                className={s['filter-select']}
              >
                <option value="">All</option>
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.icon} {p.label}
                  </option>
                ))}
              </select>
            </div>
            {activeTab === 'sprint' && (
              <div className={s['filter-group']}>
                <label>Status</label>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className={s['filter-select']}
                >
                  <option value="">All</option>
                  {COLUMNS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon} {c.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {filterCount > 0 && (
              <button
                className={`btn btn-secondary btn-sm ${s['clear-filters-btn']}`}
                onClick={clearFilters}
              >
                ✕ Clear
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
