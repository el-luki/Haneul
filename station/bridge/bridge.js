// Haneul Station bridge: Haneul (Cloudflare) ⇄ this PC ⇄ the Uno (USB serial).
// Every 5 s it asks Haneul for her state and sends it to the Uno; when you press the knob, the Uno
// says FOCUS <min> or STOP and this starts/ends a focus session in Haneul.
//
//   cd station/bridge && npm install && npm start
//
// config.json (not in git, it holds the device key):  { "key": "…", "port": "auto" }
const fs = require("fs");
const path = require("path");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const BASE = cfg.base || "https://haneul.YOUR-SUBDOMAIN.workers.dev";
const EVERY_MS = 5000;

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const clean = (s) => String(s || "").replace(/[|\r\n]/g, "/").slice(0, 16);

async function haneul(route, method = "GET", params = {}) {
  const u = new URL(`${BASE}/device/${route}`);
  u.searchParams.set("key", cfg.key);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { method, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Haneul ${route}: ${res.status}`);
  return res.json();
}

// The Uno shows up as "Arduino" (original) or a CH340/CP210x chip (clones like Elegoo's).
async function findPort() {
  if (cfg.port && cfg.port !== "auto") return cfg.port;
  const ports = await SerialPort.list();
  const uno = ports.find((p) => /arduino|wch|ch340|cp210|usb-serial|usb serial/i.test(`${p.manufacturer} ${p.friendlyName || ""}`)) || ports[0];
  if (!uno) throw new Error("No serial port found. Is the Uno plugged in?");
  return uno.path;
}

let port = null, lastMsgId = null, busy = false;

async function sendState() {
  if (!port?.isOpen || busy) return;
  busy = true;
  try {
    const s = await haneul("state");
    const beep = lastMsgId !== null && s.msgId > lastMsgId ? 1 : 0;
    lastMsgId = s.msgId;
    const [r, g, b] = s.color || [170, 120, 255];
    const line = `S|${s.mode}|${r}|${g}|${b}|${s.focusLeft}|${beep}|${clean(s.line1)}|${clean(s.line2)}\n`;
    port.write(line);
    if (beep) log("she texted → chime");
  } catch (err) {
    log("state:", err.message);
  } finally { busy = false; }
}

async function onUnoLine(line) {
  line = line.trim();
  if (!line) return;
  try {
    if (line === "HELLO") { log("Uno ready"); setTimeout(sendState, 300); return; }
    const m = line.match(/^FOCUS (\d{1,3})$/);
    if (m) { await haneul("focus", "POST", { min: m[1], label: cfg.focusLabel || "Deep work" }); log(`focus started: ${m[1]} min`); }
    else if (line === "STOP") { const r = await haneul("stop", "POST"); log(`focus stopped (${r.minutes || 0} min logged)`); }
    await sendState();
  } catch (err) { log("knob:", err.message); }
}

async function connect() {
  try {
    const p = await findPort();
    port = new SerialPort({ path: p, baudRate: 115200 });
    port.pipe(new ReadlineParser({ delimiter: "\n" })).on("data", onUnoLine);
    port.on("open", () => log(`connected to the Uno on ${p}`));
    port.on("close", () => { log("Uno disconnected, retrying in 5 s"); port = null; setTimeout(connect, 5000); });
    port.on("error", (e) => log("serial:", e.message));
  } catch (err) {
    log(err.message, "(retrying in 5 s)");
    setTimeout(connect, 5000);
  }
}

if (!cfg.key) { console.error("config.json needs a \"key\" (the device key)."); process.exit(1); }
connect();
setInterval(sendState, EVERY_MS);
