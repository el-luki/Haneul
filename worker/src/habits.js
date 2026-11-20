import { chat } from "./chat.js";
import { HABIT_HOUR, HABIT_MINUTE } from "./config.js";
import { addDaysISO, daysBetween, mondayOf, todayISO } from "./dates.js";
import { send, tg } from "./telegram.js";
import { nextId } from "./todos.js";

// ---------- Habit tracker ----------
// Evening check-in at HABIT_HOUR:HABIT_MINUTE with tap-to-tick buttons.
// days: 0 = Sunday … 6 = Saturday; empty = every day.

export const DEFAULT_HABITS = [
  { id: 1, name: "Music practice", days: [] },
  { id: 2, name: "Read space-tech article", days: [2, 4] },
  { id: 3, name: "Explore TKS.life module", days: [1, 3] },
  { id: 4, name: "CS50P (coding)", days: [2, 4] },
];
export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const DAY_WORDS = {
  sun: 0, sunday: 0, dom: 0, domingo: 0, mon: 1, monday: 1, lun: 1, lunes: 1, tue: 2, tuesday: 2, mar: 2, martes: 2,
  wed: 3, wednesday: 3, mie: 3, miercoles: 3, "miércoles": 3, thu: 4, thursday: 4, jue: 4, jueves: 4,
  fri: 5, friday: 5, vie: 5, viernes: 5, sat: 6, saturday: 6, sab: 6, sabado: 6, "sábado": 6,
};

export async function getHabits(env) {
  return (await env.DB.get("habits", "json")) || { list: DEFAULT_HABITS, log: {} };
}

export async function saveHabits(env, h) {
  // keep ~6 months of history
  for (const d of Object.keys(h.log)) if (daysBetween(d, todayISO()) > 200) delete h.log[d];
  await env.DB.put("habits", JSON.stringify(h));
}

export function habitDue(habit, iso) {
  return !habit.days.length || habit.days.includes(new Date(`${iso}T12:00:00Z`).getUTCDay());
}

export function habitStreak(habit, log) {
  let day = todayISO();
  if (!(log[day] || []).includes(habit.id)) day = addDaysISO(day, -1);
  let streak = 0;
  for (let i = 0; i < 200; i++, day = addDaysISO(day, -1)) {
    if (!habitDue(habit, day)) continue; // days it isn't scheduled don't count
    if ((log[day] || []).includes(habit.id)) streak++;
    else break;
  }
  return streak;
}

export function habitWeek(habit, log) {
  let done = 0, due = 0;
  for (let d = mondayOf(todayISO()); d <= todayISO(); d = addDaysISO(d, 1)) {
    if (!habitDue(habit, d)) continue;
    due++;
    if ((log[d] || []).includes(habit.id)) done++;
  }
  return { done, due };
}

export function habitButtons(h, iso) {
  const done = h.log[iso] || [];
  return h.list
    .filter((x) => habitDue(x, iso))
    .map((x) => [{ text: `${done.includes(x.id) ? "✅" : "⬜"} ${x.name}`, callback_data: `hb:${iso}:${x.id}` }]);
}

export async function habitCheckin(env) {
  const h = await getHabits(env);
  const today = todayISO();
  const buttons = habitButtons(h, today);
  if (!buttons.length) return;
  await send(env, "🔁 Habits: tap what you did today.", { reply_markup: { inline_keyboard: buttons } });
}

export async function toggleHabit(env, q, iso, id) {
  const h = await getHabits(env);
  const done = new Set(h.log[iso] || []);
  done.has(id) ? done.delete(id) : done.add(id);
  h.log[iso] = [...done];
  await saveHabits(env, h);
  if (q) {
    await tg(env, "editMessageReplyMarkup", {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      reply_markup: { inline_keyboard: habitButtons(h, iso) },
    }).catch(() => {});
    return;
  }
  const habit = h.list.find((x) => x.id === id);
  return send(env, `${done.has(id) ? "✅" : "⬜"} ${habit?.name}: ${done.has(id) ? "done today" : "unticked"} · 🔥 ${habitStreak(habit, h.log)}`);
}

export function parseDays(words) {
  const days = [];
  const rest = [];
  for (const w of words) {
    const d = DAY_WORDS[w.toLowerCase().replace(/[.,]/g, "")];
    if (d !== undefined) days.push(d);
    else rest.push(w);
  }
  return { days: [...new Set(days)].sort(), rest };
}

export async function onHabitCommand(env, cmd, arg) {
  const h = await getHabits(env);
  const [act = "", ...words] = arg.split(/\s+/).filter(Boolean);
  const a = act.toLowerCase();

  if (cmd === "/habit" && /^\d+$/.test(a)) return toggleHabit(env, null, todayISO(), Number(a));
  if (cmd === "/habit" && a === "add") {
    const { days, rest } = parseDays(words);
    if (!rest.length) return send(env, "Name the habit, e.g.: /habit add Read 20 min · or /habit add Gym mon wed fri");
    const habit = { id: nextId(h.list), name: rest.join(" ").slice(0, 60), days };
    h.list.push(habit);
    await saveHabits(env, h);
    return send(env, `➕ New habit #${habit.id}: ${habit.name} (${days.length ? days.map((d) => DAY_NAMES[d]).join(" ") : "every day"})`);
  }
  if (cmd === "/habit" && (a === "remove" || a === "delete")) {
    const id = Number(words[0]);
    if (!h.list.some((x) => x.id === id)) return send(env, "Which one? /habits shows the numbers. e.g. /habit remove 2");
    h.list = h.list.filter((x) => x.id !== id);
    await saveHabits(env, h);
    return send(env, `🗑️ Removed habit #${id}.`);
  }
  if (cmd === "/habit" && a === "days") {
    const id = Number(words[0]);
    const habit = h.list.find((x) => x.id === id);
    if (!habit) return send(env, "e.g. /habit days 2 tue thu (or /habit days 2 every)");
    habit.days = words.slice(1).some((w) => /every|todos/i.test(w)) ? [] : parseDays(words.slice(1)).days;
    await saveHabits(env, h);
    return send(env, `📅 ${habit.name}: ${habit.days.length ? habit.days.map((d) => DAY_NAMES[d]).join(" ") : "every day"}`);
  }
  if (cmd === "/habit" && a) {
    return send(env, "Habit commands:\n/habits: list + streaks\n/habit 2: tick #2 for today\n/habit add <name> [mon tue …]\n/habit days 2 tue thu\n/habit remove 2");
  }

  // /habits: overview
  if (!h.list.length) return send(env, "🔁 No habits yet. /habit add <name>");
  const lines = h.list.map((x) => {
    const w = habitWeek(x, h.log);
    const days = x.days.length ? x.days.map((d) => DAY_NAMES[d]).join(" ") : "every day";
    return `#${x.id} ${x.name} (${days})\n   🔥 ${habitStreak(x, h.log)} · this week ${w.done}/${w.due}`;
  });
  return send(env, `🔁 Your habits\n\n${lines.join("\n")}\n\nEvening check-in at ${HABIT_HOUR}:${HABIT_MINUTE}. Tick one now: /habit <number>`, {
    reply_markup: { inline_keyboard: habitButtons(h, todayISO()) },
  });
}
