# Haneul Station

Haneul on your desk: the salvaged 15.6" panel shows her app in **Station mode**, and a small **face module**
(Arduino UNO + parts from the Elegoo kit) gives her eyes, a mood light, a chime, an "overdue" flag and a focus knob.

```
Haneul (Cloudflare) ──HTTPS──▶ PC: bridge.js ──USB──▶ Arduino UNO ──▶ eyes · light · buzzer · flag · LCD
        ▲                                                   │
        └──────────── focus start/stop ◀──── the knob ──────┘
PC ──HDMI──▶ eDP board ──▶ 15.6" panel showing /app?station
```

## 1. The screen (Station mode)
Open `https://haneul.YOUR-SUBDOMAIN.workers.dev/app?station` on the screen
(or Haneul's Settings → Station mode → Open), and make that browser window full screen (F11).
It shows the time, the Lima sky, Haneul's face and her last text, the focus countdown, today, your to-dos,
and phone time / LinkedIn streak / newsletter. It keeps the screen awake and hides the cursor.
Move the mouse to see ✕, or press Esc, to leave.

## 2. The face module: wiring
Everything goes on the breadboard with jumper wires. **Nothing is soldered**, so the kit goes back in May as it came.
Power: the Uno's 5V and GND go to the breadboard's + and − rails; every module's VCC/GND goes to those rails.

| Part (kit) | Part pin | Uno pin |
|---|---|---|
| MAX7219 8×8 matrix | VCC / GND | 5V rail / GND rail |
| | DIN | **12** |
| | CS | **10** |
| | CLK | **11** |
| Rotary encoder module | + / GND | 5V rail / GND rail |
| | CLK | **A0** |
| | DT | **A1** |
| | SW | **A2** |
| RGB LED (common cathode: long leg) | long leg | GND rail |
| | red leg → 220 Ω → | **5** |
| | green leg → 220 Ω → | **6** |
| | blue leg → 220 Ω → | **3** |
| Passive buzzer | + / − | **8** / GND rail |
| SG90 servo | brown / red / orange | GND rail / 5V rail / **9** |
| LCD1602 | VSS / VDD | GND rail / 5V rail |
| | V0 | middle leg of the 10k potentiometer (outer legs to 5V and GND): turn it until text shows |
| | RS / RW / E | **7** / GND rail / **2** |
| | D4 / D5 / D6 / D7 | **A3** / **A4** / **A5** / **4** |
| | A / K (backlight) | 5V rail through 220 Ω / GND rail |

The LCD is optional: without it, everything else still works.
If the RGB LED shows the wrong colors (white when it should be off), set `RGB_COMMON_ANODE = true` in the sketch.
The servo can twitch the Uno's power when it moves; if the Uno resets, power the servo from the kit's power supply module instead (keep GND shared).

## 3. Upload the sketch
1. Arduino IDE → Library Manager → install **LedControl** (by Eberhard Fahle).
2. Open `uno/haneul_face/haneul_face.ino`, Board: *Arduino Uno*, pick its port, Upload.
3. The eyes appear and the LCD says "waiting for PC..".

## 4. Run the bridge
Needs Node.js (you have it). In a terminal:
```
cd station/bridge
npm install
npm start
```
`config.json` already holds the device key (it's in `.gitignore`, never commit it). `"port": "auto"` finds the Uno;
if it picks the wrong one, put e.g. `"COM4"` there. Close the Arduino IDE's Serial Monitor first: only one program can use the port.

## What it does
| Haneul's state | Eyes | Light | Sound / flag |
|---|---|---|---|
| idle | open, blinks, glances around | lavender | – |
| she just texted | happy ^ ^ | pink pulse | soft two-note chime |
| a to-do is overdue | wide, flashing dot | amber | flag goes up |
| focus session | narrow, determined | teal, slow breathing | melody when it ends |
| 21:00–5:00 | closed, matrix off-dim | dim blue | quiet (no chime) |
| PC/bridge offline | tired | almost off | – |

**The knob:** turn it to pick 15 / 25 / 45 / 60 / 90 minutes (the LCD shows "Focus 45 min?"), press to start a focus
session (Spotify focus music, texts on hold, apps blocked, minutes logged). Hold it for 1 second during a session to stop.

## May: giving the kit back
Unplug the jumper wires, take the modules out of their printed holders, and the kit is complete again.
Your replacement: an ESP32 (it has Wi-Fi, so it talks to Haneul without the PC) + your own MAX7219 and encoder.
The sketch moves over with new pin numbers, and the bridge is no longer needed.
