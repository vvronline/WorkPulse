import React, { useMemo } from 'react';
import { Doughnut } from 'react-chartjs-2';
import { PieChart, Building2 } from 'lucide-react';
import { formatTime } from '../../utils/time';
import { tooltipStyle, legendStyle, chartTextColor } from './chartConfig';
import s from './Analytics.module.css';

export function TimeDistributionChart({ totalFloor, totalBreak }) {
    const doughnutData = useMemo(() => ({
        labels: ['Work Time', 'Break Time'],
        datasets: [{
            data: [totalFloor, totalBreak],
            backgroundColor: ['rgba(14, 165, 233, 0.8)', 'rgba(245, 158, 11, 0.8)'],
            hoverBackgroundColor: ['rgba(14, 165, 233, 1)', 'rgba(245, 158, 11, 1)'],
            borderWidth: 0,
            hoverOffset: 10,
            spacing: 4,
        }],
    }), [totalFloor, totalBreak]);

    const doughnutOptions = {
        responsive: true,
        cutout: '65%',
        plugins: {
            legend: { position: 'bottom', labels: { ...legendStyle, padding: 16 } },
            tooltip: {
                ...tooltipStyle,
                callbacks: {
                    label: ctx => `${ctx.label}: ${formatTime(ctx.parsed)}`
                }
            }
        },
    };

    return (
        <div className={s['chart-card']}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><PieChart size={17} /> Time Distribution</h3>
            <Doughnut data={doughnutData} options={doughnutOptions} />
        </div>
    );
}

export function WorkModeChart({ officeDays, remoteDays }) {
    return (
        <div className={s['chart-card']}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><Building2 size={17} /> Office vs Remote</h3>
            <Doughnut data={{
                labels: ['Office', 'Remote'],
                datasets: [{
                    data: [officeDays, remoteDays],
                    backgroundColor: ['rgba(14, 165, 233, 0.8)', 'rgba(34, 197, 94, 0.8)'],
                    hoverBackgroundColor: ['rgba(14, 165, 233, 1)', 'rgba(34, 197, 94, 1)'],
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
                        ...tooltipStyle,
                        callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed} days` }
                    }
                },
            }} />
        </div>
    );
}
