import React, { useState, useEffect, useMemo } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import { BarChart3 } from 'lucide-react';
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, BarElement, LineElement,
    PointElement, Title, Tooltip, Legend, Filler, ArcElement,
} from 'chart.js';
import { getAnalytics, getHistory, getLocalDate, getLocalToday, exportMyAnalytics } from '../../api';
import ExportButton from '../../components/common/ExportButton';
import SummaryStats from './SummaryStats';
import WorkBreakChart from './WorkBreakChart';
import TrendChart from './TrendChart';
import { TimeDistributionChart, WorkModeChart } from './DistributionCharts';
import HistoryTable from './HistoryTable';
import s from './Analytics.module.css';

ChartJS.register(
    CategoryScale, LinearScale, BarElement, LineElement,
    PointElement, Title, Tooltip, Legend, Filler, ArcElement
);

export default function Analytics() {
    const [days, setDays] = useState(7);
    const [data, setData] = useState([]);
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useAutoDismiss('');

    useEffect(() => {
        let cancelled = false;
        const fetchData = async () => {
            setLoading(true);
            try {
                const [analyticsRes, historyRes] = await Promise.allSettled([
                    getAnalytics(days),
                    getHistory(getLocalDate(days), getLocalToday())
                ]);
                if (cancelled) return;
                if (analyticsRes.status === 'fulfilled') setData(analyticsRes.value.data);
                else setError('Failed to load analytics chart data.');
                if (historyRes.status === 'fulfilled') setHistory(historyRes.value.data);
                else if (analyticsRes.status === 'fulfilled') setError('Failed to load history data.');
            } catch (err) {
                if (cancelled) return;
                console.error('Failed to load analytics', err);
                setError('Failed to load analytics data. Please try again.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        fetchData();
        return () => { cancelled = true; };
    }, [days]);

    const labels = useMemo(() => data.map(d => {
        const date = new Date(d.date + 'T00:00:00');
        return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }), [data]);

    const floorHours = useMemo(() => data.map(d => +(d.floorMinutes / 60).toFixed(2)), [data]);
    const breakHours = useMemo(() => data.map(d => +(d.breakMinutes / 60).toFixed(2)), [data]);

    const totalFloor = useMemo(() => data.reduce((sum, d) => sum + d.floorMinutes, 0), [data]);
    const totalBreak = useMemo(() => data.reduce((sum, d) => sum + d.breakMinutes, 0), [data]);
    const officeDays = data.filter(d => d.floorMinutes > 0 && d.workMode !== 'remote').length;
    const remoteDays = data.filter(d => d.floorMinutes > 0 && d.workMode === 'remote').length;

    return (
        <div className={s.analytics}>
            <h2><BarChart3 size={22} style={{ marginRight: 8, verticalAlign: 'middle' }} /> Analytics & History</h2>

            <div className={s.toolbar}>
                <div className={s['date-filter']}>
                    {[7, 14, 30].map(d => (
                        <button key={d} className={days === d ? s.active : ''} onClick={() => setDays(d)}>
                            Last {d} days
                        </button>
                    ))}
                </div>
                <ExportButton
                    fetchFn={exportMyAnalytics}
                    params={{ from: getLocalDate(days), to: getLocalToday() }}
                    label="Export Analytics"
                />
            </div>

            {loading ? (
                <div className={s['analytics-skeleton']}>
                    <div className={s['sk-stats-row']}>
                        {[0, 1, 2, 3].map(i => <div key={i} className={s['sk-stat-card']} />)}
                    </div>
                    <div className={s['sk-chart-lg']} />
                    <div className={s['sk-chart-row']}>
                        <div className={s['sk-chart-sm']} />
                        <div className={s['sk-chart-sm']} />
                    </div>
                    <div className={s['sk-table']} />
                </div>
            ) : error ? (
                <div className={`error-msg ${s['section-divider']}`}>{error}</div>
            ) : (
                <>
                    <SummaryStats data={data} />

                    <div className={s['analytics-charts-row']}>
                        <WorkBreakChart labels={labels} floorHours={floorHours} breakHours={breakHours} />
                        <TrendChart labels={labels} floorHours={floorHours} />
                    </div>

                    <div className={s['analytics-detail-grid']}>
                        <TimeDistributionChart totalFloor={totalFloor} totalBreak={totalBreak} />
                        <WorkModeChart officeDays={officeDays} remoteDays={remoteDays} />
                        <HistoryTable history={history} />
                    </div>
                </>
            )}
        </div>
    );
}
