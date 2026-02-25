import React, { useState, useEffect } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ArcElement,
} from 'chart.js';
import { Bar, Line, Doughnut } from 'react-chartjs-2';
import { getAnalytics, getHistory, getLocalDate, getLocalToday } from '../api';
import s from './Analytics.module.css';

ChartJS.register(
  CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, Title, Tooltip, Legend, Filler, ArcElement
);

function formatTime(totalMinutes) {
  const hrs = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hrs}h ${mins}m`;
}

export default function Analytics() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetch = async () => {
      setLoading(true);
      try {
        const [analyticsRes, historyRes] = await Promise.all([
          getAnalytics(days),
          getHistory(
            getLocalDate(days),
            getLocalToday()
          )
        ]);
        setData(analyticsRes.data);
        setHistory(historyRes.data);
      } catch (err) {
        console.error('Failed to load analytics', err);
      } finally {
        setLoading(false);
      }
    };
    fetch();
  }, [days]);

  const labels = data.map(d => {
    const date = new Date(d.date + 'T00:00:00');
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  });

  const floorHours = data.map(d => +(d.floorMinutes / 60).toFixed(2));
  const breakHours = data.map(d => +(d.breakMinutes / 60).toFixed(2));

  const chartTextColor = '#94a3b8';
  const chartGridColor = 'rgba(255,255,255,0.05)';

  // Bar Chart: Floor vs Break time daily
  const barData = {
    labels,
    datasets: [
      {
        label: 'Work Time (hrs)',
        data: floorHours,
        backgroundColor: 'rgba(99, 102, 241, 0.7)',
        hoverBackgroundColor: 'rgba(99, 102, 241, 0.9)',
        borderRadius: 8,
        borderSkipped: false,
      },
      {
        label: 'Break Time (hrs)',
        data: breakHours,
        backgroundColor: 'rgba(245, 158, 11, 0.7)',
        hoverBackgroundColor: 'rgba(245, 158, 11, 0.9)',
        borderRadius: 8,
        borderSkipped: false,
      },
    ],
  };

  const barOptions = {
    responsive: true,
    plugins: {
      legend: { position: 'top', labels: { color: chartTextColor, usePointStyle: true, pointStyle: 'circle', padding: 20 } },
      tooltip: {
        backgroundColor: 'rgba(15,15,26,0.9)',
        titleColor: '#f1f5f9',
        bodyColor: '#94a3b8',
        borderColor: 'rgba(255,255,255,0.1)',
        borderWidth: 1,
        cornerRadius: 10,
        padding: 12,
        callbacks: {
          label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} hrs`
        }
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        title: { display: true, text: 'Hours', color: chartTextColor },
        grid: { color: chartGridColor },
        ticks: { color: chartTextColor },
      },
      x: {
        grid: { display: false },
        ticks: { color: chartTextColor },
      }
    },
  };

  // Line Chart: Trend with 8hr target line
  const lineData = {
    labels,
    datasets: [
      {
        label: 'Work Time (hrs)',
        data: floorHours,
        borderColor: '#818cf8',
        backgroundColor: 'rgba(99, 102, 241, 0.08)',
        fill: true,
        tension: 0.4,
        pointRadius: 5,
        pointBackgroundColor: '#818cf8',
        pointBorderColor: '#818cf8',
        pointHoverRadius: 7,
        borderWidth: 2.5,
      },
      {
        label: '8hr Target',
        data: new Array(labels.length).fill(8),
        borderColor: '#4ade80',
        borderDash: [8, 4],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
      },
    ],
  };

  const lineOptions = {
    responsive: true,
    plugins: {
      legend: { position: 'top', labels: { color: chartTextColor, usePointStyle: true, pointStyle: 'circle', padding: 20 } },
      tooltip: {
        backgroundColor: 'rgba(15,15,26,0.9)',
        titleColor: '#f1f5f9',
        bodyColor: '#94a3b8',
        borderColor: 'rgba(255,255,255,0.1)',
        borderWidth: 1,
        cornerRadius: 10,
        padding: 12,
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        title: { display: true, text: 'Hours', color: chartTextColor },
        grid: { color: chartGridColor },
        ticks: { color: chartTextColor },
      },
      x: {
        grid: { display: false },
        ticks: { color: chartTextColor },
      }
    },
  };

  // Doughnut: Total floor vs break in period
  const totalFloor = data.reduce((sum, d) => sum + d.floorMinutes, 0);
  const totalBreak = data.reduce((sum, d) => sum + d.breakMinutes, 0);

  const doughnutData = {
    labels: ['Work Time', 'Break Time'],
    datasets: [
      {
        data: [totalFloor, totalBreak],
        backgroundColor: ['rgba(99, 102, 241, 0.8)', 'rgba(245, 158, 11, 0.8)'],
        hoverBackgroundColor: ['rgba(99, 102, 241, 1)', 'rgba(245, 158, 11, 1)'],
        borderWidth: 0,
        hoverOffset: 10,
        spacing: 4,
      },
    ],
  };

  const doughnutOptions = {
    responsive: true,
    cutout: '65%',
    plugins: {
      legend: { position: 'bottom', labels: { color: chartTextColor, usePointStyle: true, pointStyle: 'circle', padding: 16 } },
      tooltip: {
        backgroundColor: 'rgba(15,15,26,0.9)',
        titleColor: '#f1f5f9',
        bodyColor: '#94a3b8',
        borderColor: 'rgba(255,255,255,0.1)',
        borderWidth: 1,
        cornerRadius: 10,
        padding: 12,
        callbacks: {
          label: ctx => {
            const mins = ctx.parsed;
            return `${ctx.label}: ${formatTime(mins)}`;
          }
        }
      }
    },
  };

  // Summary stats
  const workingDays = data.filter(d => d.floorMinutes > 0).length;
  const avgFloor = workingDays > 0 ? Math.round(totalFloor / workingDays) : 0;
  const daysMetTarget = data.filter(d => d.floorMinutes >= 480).length;
  const officeDays = data.filter(d => d.floorMinutes > 0 && d.workMode !== 'remote').length;
  const remoteDays = data.filter(d => d.floorMinutes > 0 && d.workMode === 'remote').length;

  return (
    <div className={s.analytics}>
      <h2><span className="page-icon">📊</span> Analytics & History</h2>

      {/* Date filter */}
      <div className={s['date-filter']}>
        {[7, 14, 30].map(d => (
          <button
            key={d}
            className={days === d ? s.active : ''}
            onClick={() => setDays(d)}
          >
            Last {d} days
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading-spinner"><div className="spinner"></div></div>
      ) : (
        <>
          {/* Summary Stats */}
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-label">Total Work Time</div>
              <div className="stat-value floor">{formatTime(totalFloor)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Total Break Time</div>
              <div className="stat-value break">{formatTime(totalBreak)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Avg Floor / Day</div>
              <div className="stat-value floor">{formatTime(avgFloor)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Days Met 8hr Target</div>
              <div className="stat-value total">{daysMetTarget} / {workingDays}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Office Days</div>
              <div className="stat-value" style={{ color: 'var(--primary)', WebkitTextFillColor: 'var(--primary)' }}>🏢 {officeDays}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Remote Days</div>
              <div className="stat-value" style={{ color: 'var(--success)', WebkitTextFillColor: 'var(--success)' }}>🏠 {remoteDays}</div>
            </div>
          </div>

          {/* Charts Row */}
          <div className={s['analytics-charts-row']}>
            <div className={s['chart-card']}>
              <h3>📊 Daily Floor vs Break Time</h3>
              <Bar data={barData} options={barOptions} />
            </div>
            <div className={s['chart-card']}>
              <h3>📈 Work Time Trend</h3>
              <Line data={lineData} options={lineOptions} />
            </div>
          </div>

          <div className={s['analytics-detail-grid']}>
            <div className={s['chart-card']}>
              <h3>🍩 Time Distribution</h3>
              <Doughnut data={doughnutData} options={doughnutOptions} />
            </div>

            <div className={s['chart-card']}>
              <h3>🏢 Office vs Remote</h3>
              <Doughnut data={{
                labels: ['Office', 'Remote'],
                datasets: [{
                  data: [officeDays, remoteDays],
                  backgroundColor: ['rgba(99, 102, 241, 0.8)', 'rgba(34, 197, 94, 0.8)'],
                  hoverBackgroundColor: ['rgba(99, 102, 241, 1)', 'rgba(34, 197, 94, 1)'],
                  borderWidth: 0,
                  hoverOffset: 10,
                  spacing: 4,
                }],
              }} options={{
                responsive: true,
                cutout: '65%',
                plugins: {
                  legend: { position: 'bottom', labels: { color: chartTextColor, usePointStyle: true, pointStyle: 'circle', padding: 16 } },
                  tooltip: {
                    backgroundColor: 'rgba(15,15,26,0.9)',
                    titleColor: '#f1f5f9',
                    bodyColor: '#94a3b8',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    cornerRadius: 10,
                    padding: 12,
                    callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed} days` }
                  }
                },
              }} />
            </div>

            {/* History Table */}
            <div className={`${s['chart-card']} ${s['history-full']}`}>
              <h3>📋 Daily Log</h3>
              <div className={s['table-scroll-wrapper']}>
                <table className={s['history-table']}>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Mode</th>
                      <th>Work Time</th>
                      <th>Break Time</th>
                      <th>Total</th>
                      <th>8hr Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.length === 0 ? (
                      <tr>
                        <td colSpan={6} className={s['empty-cell']}>
                          No data for this period
                        </td>
                      </tr>
                    ) : (
                      history.map((day, i) => {
                        const met = day.floorMinutes >= 480;
                        return (
                          <tr key={i}>
                            <td className={s['date-cell']}>
                              {new Date(day.date + 'T00:00:00').toLocaleDateString('en-US', {
                                weekday: 'short', month: 'short', day: 'numeric'
                              })}
                            </td>
                            <td>
                              <span className={`${s['mode-badge']} ${day.workMode === 'remote' ? s['mode-remote'] : s['mode-office']}`}>
                                {day.workMode === 'remote' ? '🏠' : '🏢'} {day.workMode === 'remote' ? 'Remote' : 'Office'}
                              </span>
                            </td>
                            <td className={s['work-cell']}>
                              {formatTime(day.floorMinutes)}
                            </td>
                            <td className={s['break-cell']}>
                              {formatTime(day.breakMinutes)}
                            </td>
                            <td>{formatTime(day.floorMinutes + day.breakMinutes)}</td>
                            <td>
                              <span className={`${s['target-badge']} ${met ? s.met : s['not-met']}`}>
                                {met ? '✓ Met' : '✗ Not Met'}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
