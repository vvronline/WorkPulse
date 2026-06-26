import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar as CalendarIcon } from "lucide-react";
import Calendar from "../components/calendar/Calendar";
import { getTasks, getLocalToday } from "../api";
import { useAuth } from "../AuthContext";
import s from "./CalendarPage.module.css";

const EMPTY: any[] = [];

export default function CalendarPage() {
  const { user } = useAuth() as any;
  const today = getLocalToday();

  // Stale-while-revalidate: cached due-date tasks (restored from localStorage
  // on a cold start) render instantly while a background refetch keeps them
  // current. Keyed by date so it refetches when the day rolls over.
  const { data } = useQuery({
    queryKey: ["calendar", "page-tasks", today],
    queryFn: async () => {
      const res = await getTasks(today, {
        scope: "personal",
        include_due: "1",
      } as any);
      return (res.data as any).tasks || [];
    },
  });
  const tasks: any[] = data ?? EMPTY;

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h2 style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <CalendarIcon size={22} /> Calendar
        </h2>
        <p>Schedule events and manage your time</p>
      </div>
      <div className={s.calendarWrap}>
        <Calendar tasks={tasks} />
      </div>
    </div>
  );
}
