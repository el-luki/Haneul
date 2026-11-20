import { BUS_HOURS, TZ, WEATHER } from "./config.js";

// ---------- Weather (Open-Meteo: free, no key) ----------

export function weatherEmoji(code) {
  if (code === 0) return "☀️";
  if (code <= 3) return "⛅";
  if (code <= 48) return "🌫️";
  if (code <= 67) return "🌧️";
  if (code <= 77) return "🌨️";
  if (code <= 82) return "🌦️";
  return "⛈️";
}

export async function weatherText() {
  const params = new URLSearchParams({
    latitude: WEATHER.lat,
    longitude: WEATHER.lon,
    current: "temperature_2m,weather_code",
    hourly: "precipitation_probability",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: TZ,
    forecast_days: "2",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`weather service said ${res.status}`);
  const f = await res.json();

  const rainAt = (iso, hoursList) =>
    Math.max(
      ...hoursList.map((h) => {
        const i = f.hourly.time.indexOf(`${iso}T${String(h).padStart(2, "0")}:00`);
        return i >= 0 ? f.hourly.precipitation_probability[i] ?? 0 : 0;
      })
    );

  const lines = [`${weatherEmoji(f.current.weather_code)} ${WEATHER.name} now: ${Math.round(f.current.temperature_2m)}°C`];
  ["Today", "Tomorrow"].forEach((label, i) => {
    const iso = f.daily.time[i];
    const morning = rainAt(iso, BUS_HOURS.morning);
    const afternoon = rainAt(iso, BUS_HOURS.afternoon);
    lines.push(
      `\n${weatherEmoji(f.daily.weather_code[i])} ${label}: ${Math.round(f.daily.temperature_2m_min[i])}–${Math.round(f.daily.temperature_2m_max[i])}°C, ` +
        `rain chance up to ${f.daily.precipitation_probability_max[i]}%` +
        `\n🚌 Bus 6–7am: ${morning}% · 3–4pm: ${afternoon}%` +
        (Math.max(morning, afternoon) >= 40 ? "\n☂️ Bring an umbrella." : "")
    );
  });
  return lines.join("\n");
}

// The sky over Lima right now, for the app's live sky icon: temperature, condition, day/night,
// sunrise/sunset, and the next hours.
export async function skyNow() {
  const params = new URLSearchParams({
    latitude: WEATHER.lat,
    longitude: WEATHER.lon,
    current: "temperature_2m,weather_code,is_day,cloud_cover",
    hourly: "temperature_2m,weather_code,precipitation_probability",
    daily: "sunrise,sunset,temperature_2m_max,temperature_2m_min",
    timezone: TZ,
    forecast_days: "2",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`weather service said ${res.status}`);
  const f = await res.json();
  const nowIso = f.current.time.slice(0, 13); // "2026-11-14T10"
  const i0 = Math.max(0, f.hourly.time.findIndex((t) => t.slice(0, 13) === nowIso));
  const next = f.hourly.time.slice(i0 + 1, i0 + 7).map((t, k) => ({
    hour: t.slice(11, 16),
    temp: Math.round(f.hourly.temperature_2m[i0 + 1 + k]),
    code: f.hourly.weather_code[i0 + 1 + k],
    rain: f.hourly.precipitation_probability[i0 + 1 + k] ?? 0,
  }));
  return {
    place: WEATHER.name,
    time: f.current.time.slice(11, 16),
    temp: Math.round(f.current.temperature_2m),
    code: f.current.weather_code,
    clouds: f.current.cloud_cover,
    day: !!f.current.is_day,
    sunrise: f.daily.sunrise[0].slice(11, 16),
    sunset: f.daily.sunset[0].slice(11, 16),
    max: Math.round(f.daily.temperature_2m_max[0]),
    min: Math.round(f.daily.temperature_2m_min[0]),
    next,
  };
}
