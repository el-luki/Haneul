import { addDaysISO, todayISO } from "./dates.js";

// ---------- Bible reading log (his church's monthly "Monthly" sheet) ----------
// Every day at 20:00 Haneul asks (in Spanish) what he read / prayed / attended; his answer fills the
// day's fields of the sheet. The app page /app/biblia shows the month like the paper sheet
// (print → PDF) and downloads it as CSV. Everything is in Spanish, like the sheet.
// KV "bible": { "2026-11-16": { ore, lei, oracion_modo, oracion_de, oracion_a, oracion_min, culto_modo, culto_hora, por_que_virtual } }

export const CULTOS = {
  0: ["7:30 a. m.", "9:30 a. m.", "11:30 a. m.", "1:30 p. m."], // domingo
  3: ["5:00 p. m.", "7:00 p. m."], // miércoles
  6: ["1:00 p. m.", "3:00 p. m.", "5:00 p. m.", "7:00 p. m."], // sábado
};
export const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
export const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const FIELDS = ["ore", "lei", "oracion_modo", "oracion_de", "oracion_a", "oracion_min", "culto_modo", "culto_hora", "por_que_virtual"];

const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();

// Which boxes the sheet has on that day.
export function dayFields(iso) {
  const wd = weekday(iso);
  return {
    ore: wd !== 2 && wd !== 4, // "Hoy oré ___ minutos" (not on Tue/Thu: those have «la oración»)
    oracion: wd === 2 || wd === 4, // "Hoy me conecté/asistí a «la oración» de ___ a ___ (___ minutos)"
    culto: CULTOS[wd] || null, // "Hoy me conecté/asistí al culto de las: …"
    virtual: wd === 0 || wd === 3, // "¿Por qué me conecté virtual?"
  };
}

export function fieldsText(iso) {
  const f = dayFields(iso);
  return [
    "Y leí ___ en la Biblia (book + chapters/verses)",
    f.ore && "Hoy oré ___ minutos",
    f.oracion && "«la oración» (prayer meeting): conecté (online) or asistí (in person), from ___ to ___ (times), ___ minutos",
    f.culto && `culto (service): conecté (online) or asistí (in person), at one of: ${f.culto.join(", ")}`,
    f.virtual && "¿Por qué me conecté virtual? (only if he joined online)",
  ].filter(Boolean).join("; ");
}

export async function getBible(env) {
  return (await env.DB.get("bible", "json")) || {};
}

// Merges what he said into the day(s). Empty values don't erase what's there.
export async function logBible(env, entries) {
  const log = await getBible(env);
  const done = [];
  for (const e of entries || []) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(e?.date || "") ? e.date : todayISO();
    const day = { ...(log[date] || {}) };
    for (const k of FIELDS) {
      let v = e[k];
      if (v === undefined || v === null || v === "") continue;
      if (k.endsWith("_min") || k === "ore") v = Math.max(0, Math.min(600, Math.round(Number(v) || 0)));
      else if (k.endsWith("_modo")) v = /conect|virtual|online|en l[ií]nea/i.test(v) ? "conecté" : "asistí";
      else v = String(v).trim().slice(0, 200);
      day[k] = v;
    }
    log[date] = day;
    done.push(date);
  }
  await env.DB.put("bible", JSON.stringify(log));
  return done;
}

export async function setBibleDay(env, date, day) {
  const log = await getBible(env);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "bad date" };
  const clean = {};
  for (const k of FIELDS) if (day?.[k] !== undefined && day[k] !== "") clean[k] = k === "ore" || k.endsWith("_min") ? Number(day[k]) || 0 : String(day[k]).slice(0, 200);
  if (Object.keys(clean).length) log[date] = clean; else delete log[date];
  await env.DB.put("bible", JSON.stringify(log));
  return { ok: true };
}

// Days in a row with a reading, up to today (or yesterday, if today isn't logged yet).
export function bibleStreak(log, today = todayISO()) {
  let d = log[today]?.lei ? today : addDaysISO(today, -1);
  let n = 0;
  while (log[d]?.lei) { n++; d = addDaysISO(d, -1); }
  return n;
}

export async function bibleMonth(env, month) {
  const log = await getBible(env);
  const m = /^\d{4}-\d{2}$/.test(month || "") ? month : todayISO().slice(0, 7);
  const entries = Object.fromEntries(Object.entries(log).filter(([d]) => d.startsWith(m)));
  return { month: m, entries, streak: bibleStreak(log), cultos: CULTOS };
}

const short = (e) => [e.lei && `leyó ${e.lei}`, e.ore && `oró ${e.ore} min`, e.oracion_modo && `${e.oracion_modo} a la oración`, e.culto_modo && `${e.culto_modo} al culto ${e.culto_hora || ""}`].filter(Boolean).join(", ");

// For her prompt: today's boxes, what's filled this week, the streak.
export async function bibleContext(env) {
  const log = await getBible(env);
  const today = todayISO();
  const days = [0, 1, 2].map((i) => addDaysISO(today, -i));
  const lines = days.map((d, i) => `${i === 0 ? "Today" : i === 1 ? "Yesterday" : d} (${DIAS[weekday(d)]}): ${log[d] ? short(log[d]) || "(empty)" : "nothing logged yet"}`);
  return `Alex's Bible-reading log for his church's monthly sheet (in Spanish; streak ${bibleStreak(log)} day(s) of reading):
${lines.join("\n")}
Today's sheet boxes: ${fieldsText(today)}.
When he tells you what he read / prayed / attended, fill the "bible" action (values in Spanish).`;
}

// 20:00: the reminder (in Spanish, short; asks for today's boxes, and yesterday's if it's empty).
export async function bibleReminder(env, haneulSays) {
  const log = await getBible(env);
  const today = todayISO(), y = addDaysISO(today, -1);
  if (log[today]?.lei) return; // already logged today
  const missingY = !log[y]?.lei;
  await haneulSays(env, `It's 8pm: time for Alex's Bible reading (his church has a monthly sheet he hands in, and you help him keep it).
Write IN SPANISH (Latin American), 1-2 short texts, warm, not preachy: ask what he read in the Bible today${dayFields(today).ore ? " and how many minutes he prayed" : ""}${dayFields(today).oracion ? ", and whether he joined «la oración» today (online or in person)" : ""}${dayFields(today).culto ? ", and whether he went to the culto (which time)" : ""}.
${missingY ? "Yesterday is still empty on his sheet: also ask about yesterday, briefly." : ""}
His streak: ${bibleStreak(log)} day(s). If he hasn't read yet, encourage him to read a chapter now and tell you after. One question at a time feeling, no lists.`);
}

// CSV in Spanish, one row per day of the month.
export function bibleCsv({ month, entries }) {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const q = (v) => (v === undefined || v === null ? "" : /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [["Fecha", "Día", "Leí en la Biblia", "Oré (minutos)", "La oración: conecté/asistí", "La oración de", "La oración a", "La oración (minutos)", "Culto: conecté/asistí", "Culto de las", "¿Por qué me conecté virtual?"]];
  for (let d = 1; d <= days; d++) {
    const iso = `${month}-${String(d).padStart(2, "0")}`;
    const e = entries[iso] || {};
    rows.push([iso, DIAS[weekday(iso)], e.lei, e.ore, e.oracion_modo, e.oracion_de, e.oracion_a, e.oracion_min, e.culto_modo, e.culto_hora, e.por_que_virtual]);
  }
  return "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n"); // BOM: Excel opens the accents right
}
