import { TZ } from "./config.js";

// ---------- Dates ----------

export function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
}

export function todayLong() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

export function addDaysISO(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function localHour() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date()));
}

export function dayName(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

export function localMinute() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, minute: "numeric" }).format(new Date()));
}

export function localWeekday() {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date()); // "Fri"
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
}

export function mondayOf(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function prettyDue(due) {
  if (!due) return "";
  const day = new Date(`${due}T12:00:00Z`);
  const diff = Math.round((day - new Date(`${todayISO()}T12:00:00Z`)) / 86400000);
  const label = day.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  if (diff < 0) return ` (⚠️ overdue, ${label})`;
  if (diff === 0) return " (due TODAY)";
  if (diff === 1) return " (due tomorrow)";
  return ` (due ${label})`;
}

// "2026-11-05" -> "Nov 5"
export function shortDateISO(iso) {
  return iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" }) : "";
}
