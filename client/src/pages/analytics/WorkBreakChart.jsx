import React, { useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import { BarChart3 } from 'lucide-react';
import { tooltipStyle, legendStyle, axisStyle } from './chartConfig';
import s from './Analytics.module.css';

export default function WorkBreakChart({ labels, floorHours, breakHours }) {
    const barData = useMemo(() => ({
        labels,
        datasets: [
            {
                label: 'Work Time (hrs)',
                data: floorHours,
                backgroundColor: 'rgba(14, 165, 233, 0.7)',
                hoverBackgroundColor: 'rgba(14, 165, 233, 0.9)',
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
    }), [labels, floorHours, breakHours]);

    const barOptions = {
        responsive: true,
        plugins: {
            legend: { position: 'top', labels: legendStyle },
            tooltip: {
                ...tooltipStyle,
                callbacks: {
                    label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} hrs`
                }
            }
        },
        scales: {
            y: { ...axisStyle.y, title: { display: true, text: 'Hours', color: '#94a3b8' } },
            x: axisStyle.x,
        },
    };

    return (
        <div className={s['chart-card']}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><BarChart3 size={17} /> Daily Work vs Break Time</h3>
            <Bar data={barData} options={barOptions} />
        </div>
    );
}
