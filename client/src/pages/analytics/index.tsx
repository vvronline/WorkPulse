import React, { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAutoDismiss } from "../../hooks/useAutoDismiss";
import { BarChart3 } from "lucide-react";
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
} from "chart.js";
import {
  getAnalytics,
  getHistory,
  getWidgets,
  getLocalDate,
  getLocalToday,
  exportMyAnalytics,
} from "../../api";
import ExportButton from "../../components/common/ExportButton";
import WidgetsGrid from "../../components/dashboard/WidgetsGrid";
import SummaryStats from "./SummaryStats";
import WorkBreakChart from "./WorkBreakChart";
import TrendChart from "./TrendChart";
import { TimeDistributionChart, WorkModeChart } from "./DistributionCharts";
import HistoryTable from "./HistoryTable";
import s from "./Analytics.module.css";

ChartJS.register(
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
);

interface AnalyticsDay {
  date: string;
  floorMinutes: number;
  breakMinutes: number;
  workMode?: string;
  [key: string]: any;
}

const EMPTY_DAYS: AnalyticsDay[] = [];

export default function Analytics() {
  const [days, setDays] = useState<number | "custom">(7);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [error, setError] = useAutoDismiss("") as [string, (v: string) => void];

  const isCustom = days === "custom";
  const fromDate = isCustom ? customFrom : getLocalDate(days as number);
  const toDate = isCustom ? customTo : getLocalToday();

  const {
    data: result,
    isLoading,
    isError,
    error: queryError,
  } = useQuery({
    queryKey: [
      "analytics",
      days,
      isCustom ? fromDate : null,
      isCustom ? toDate : null,
    ],
    enabled: !isCustom || (!!customFrom && !!customTo),
    queryFn: async () => {
      const params = isCustom ? undefined : days;
      const [analyticsRes, historyRes, widgetsRes] = await Promise.allSettled([
        getAnalytics(
          params as any,
          isCustom ? fromDate : undefined,
          isCustom ? toDate : undefined,
        ),
        getHistory(fromDate, toDate),
        getWidgets(),
      ]);
      if (analyticsRes.status !== "fulfilled")
        throw new Error("Failed to load analytics chart data.");
      if (historyRes.status !== "fulfilled")
        throw new Error("Failed to load history data.");
      return {
        data: analyticsRes.value.data as AnalyticsDay[],
        history: historyRes.value.data as AnalyticsDay[],
        widgets:
          widgetsRes.status === "fulfilled" ? widgetsRes.value.data : null,
      };
    },
  });

  const data = result?.data ?? EMPTY_DAYS;
  const history = result?.history ?? EMPTY_DAYS;
  const widgets = result?.widgets ?? null;
  const loading = isLoading || (isCustom && (!customFrom || !customTo));

  useEffect(() => {
    if (isError)
      setError(
        (queryError as Error)?.message ||
          "Failed to load analytics data. Please try again.",
      );
  }, [isError, queryError, setError]);

  const labels = useMemo(
    () =>
      data.map((d) => {
        const date = new Date(d.date + "T00:00:00");
        return date.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
      }),
    [data],
  );

  const floorHours = useMemo(
    () => data.map((d) => +(d.floorMinutes / 60).toFixed(2)),
    [data],
  );
  const breakHours = useMemo(
    () => data.map((d) => +(d.breakMinutes / 60).toFixed(2)),
    [data],
  );

  const totalFloor = useMemo(
    () => data.reduce((sum, d) => sum + d.floorMinutes, 0),
    [data],
  );
  const totalBreak = useMemo(
    () => data.reduce((sum, d) => sum + d.breakMinutes, 0),
    [data],
  );
  const officeDays = data.filter(
    (d) => d.floorMinutes > 0 && d.workMode !== "remote",
  ).length;
  const remoteDays = data.filter(
    (d) => d.floorMinutes > 0 && d.workMode === "remote",
  ).length;

  return (
    <div className={s.analytics}>
      <h2>
        <BarChart3
          size={22}
          style={{ marginRight: 8, verticalAlign: "middle" }}
        />{" "}
        Analytics & History
      </h2>

      <div className={s.toolbar}>
        <div className={s["date-filter"]}>
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              className={days === d ? s.active : ""}
              onClick={() => setDays(d)}
            >
              Last {d} days
            </button>
          ))}
          <button
            className={isCustom ? s.active : ""}
            onClick={() => setDays("custom")}
          >
            Custom
          </button>
        </div>
        {isCustom && (
          <div className={s["custom-range"]}>
            <input
              type="date"
              value={customFrom}
              max={customTo || getLocalToday()}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <span>to</span>
            <input
              type="date"
              value={customTo}
              min={customFrom}
              max={getLocalToday()}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </div>
        )}
        <ExportButton
          fetchFn={exportMyAnalytics}
          params={{ from: fromDate, to: toDate }}
          label="Export Analytics"
        />
      </div>

      {loading ? (
        <div className={s["analytics-skeleton"]}>
          <div className={s["sk-stats-row"]}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={s["sk-stat-card"]} />
            ))}
          </div>
          <div className={s["sk-chart-lg"]} />
          <div className={s["sk-chart-row"]}>
            <div className={s["sk-chart-sm"]} />
            <div className={s["sk-chart-sm"]} />
          </div>
          <div className={s["sk-table"]} />
        </div>
      ) : error ? (
        <div className={`error-msg ${s["section-divider"]}`}>{error}</div>
      ) : (
        <>
          <WidgetsGrid widgets={widgets} />

          <SummaryStats data={data} />

          <div className={s["analytics-charts-row"]}>
            <WorkBreakChart
              labels={labels}
              floorHours={floorHours}
              breakHours={breakHours}
            />
            <TrendChart labels={labels} floorHours={floorHours} />
          </div>

          <div className={s["analytics-detail-grid"]}>
            <TimeDistributionChart
              totalFloor={totalFloor}
              totalBreak={totalBreak}
            />
            <WorkModeChart officeDays={officeDays} remoteDays={remoteDays} />
            <HistoryTable history={history} />
          </div>
        </>
      )}
    </div>
  );
}
