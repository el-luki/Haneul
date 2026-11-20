export const TZ = "America/Lima";
// Two tiers of Gemini models. Each model has its OWN free daily quota, so the bot
// spreads the work: the smart "Flash" models only allow ~20 requests a day, while
// the "Flash Lite" models allow hundreds.
//   SMART: reading handwriting (agenda, TKS notes) and weekly music
//   LIGHT: chat, WhatsApp filtering, "add" parsing
// If a model is out of quota, the next one in the list is used.
export const MODELS_LIGHT = ["gemini-flash-lite-latest", "gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview"];
export const MODELS_SMART = ["gemini-flash-latest", "gemini-3-flash-preview", ...MODELS_LIGHT];
export const PHOTO_TTL_MS = 60 * 60 * 1000; // waiting photos expire after 1 hour
export const REMIND_MINUTES = 15; // remind this many minutes before important events
export const DUE_ALERT_HOUR = 19; // 7 pm: heads-up about to-dos due tomorrow
// Evening messages all arrive before 20:30 (bedtime): AP 20:00 → habits 20:10 → journal 20:20.
export const AP_CHECKIN_HOUR = 20; // AP Physics check-in at 20:00
export const AP_CHECKIN_MINUTE = 0;
export const MUSIC_HOUR = 15; // weekly music on Fridays at 15:00 (bus ride home)
export const REVIEW_HOUR = 16; // Sunday review at 16:00
export const MONTHLY_HOUR = 17; // monthly TKS update draft: last day of the month at 17:00
export const HABIT_HOUR = 20; // habit check-in at 20:10
export const HABIT_MINUTE = 10;
export const JOURNAL_HOUR = 20; // journal question at 20:20
export const JOURNAL_MINUTE = 20;
export const KOREAN_WEEKDAY = { hour: 6, minute: 30 }; // Korean lesson on the morning bus
export const KOREAN_WEEKEND = { hour: 9, minute: 0 };
export const WEATHER = { name: "Lima", lat: -12.0464, lon: -77.0428 };
export const BUS_HOURS = { morning: [6, 7], afternoon: [15, 16] }; // rain chances checked at these hours
