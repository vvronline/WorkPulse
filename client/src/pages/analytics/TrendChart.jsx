import React, { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import { TrendingUp } from 'lucide-react';
import { tooltipStyle, legendStyle, axisStyle } from './chartConfig';
import s from './Analytics.module.css';

export default function TrendChart({ labels, floorHours }) {
    const lineData = useMemo(() => ({
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
    }), [labels, floorHours]);

    const lineOptions = {
        responsive: true,
        plugins: {
            legend: { position: 'top', labels: legendStyle },
            tooltip: tooltipStyle,
        },
        scales: {
            y: { ...axisStyle.y, title: { display: true, text: 'Hours', color: '#94a3b8' } },
            x: axisStyle.x,
        },
    };

    return (
        <div className={s['chart-card']}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><TrendingUp size={17} /> Work Time Trend</h3>
            <Line data={lineData} options={lineOptions} />
        </div>
    );
}
