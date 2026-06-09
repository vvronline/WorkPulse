const chartTextColor = "#94a3b8";
const chartGridColor = "rgba(255,255,255,0.05)";

export const tooltipStyle = {
    backgroundColor: "rgba(15,15,26,0.9)",
    titleColor: "#f1f5f9",
    bodyColor: "#94a3b8",
    borderColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    cornerRadius: 10,
    padding: 12,
};

export const legendStyle = {
    color: chartTextColor,
    usePointStyle: true,
    pointStyle: "circle",
    padding: 20,
};

export const axisStyle = {
    y: {
        beginAtZero: true,
        grid: { color: chartGridColor },
        ticks: { color: chartTextColor },
    },
    x: {
        grid: { display: false },
        ticks: { color: chartTextColor },
    },
};

export { chartTextColor, chartGridColor };