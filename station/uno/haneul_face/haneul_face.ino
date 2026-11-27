// Haneul Station: the face module (Arduino UNO, parts from the Elegoo starter kit)
//
// The PC bridge (station/bridge) sends Haneul's state over USB a few times a minute:
//   S|mode|r|g|b|focusLeftSeconds|beep|line1|line2
//   mode: idle | talk | alert | focus | sleep        beep: 1 = she just texted
// and the Uno sends back what you do with the knob:
//   FOCUS <minutes>    (turn the knob to pick, press to start)
//   STOP               (hold the knob for 1 second during a session)
//
// Everything plugs into the breadboard with jumper wires: nothing is soldered, so the kit goes back in May
// as it came. Wiring: see station/README.md.
//
// Libraries: LedControl (Library Manager → "LedControl" by Eberhard Fahle). Servo and LiquidCrystal are built in.

#include <LedControl.h>
#include <LiquidCrystal.h>
#include <Servo.h>

// ---------- pins ----------
const int MAX_DIN = 12, MAX_CLK = 11, MAX_CS = 10;   // MAX7219 8×8 matrix: her eyes
const int ENC_CLK = A0, ENC_DT = A1, ENC_SW = A2;     // rotary encoder module: the focus knob
const int LED_R = 5, LED_G = 6, LED_B = 3;            // RGB LED (each leg through a 220 Ω resistor)
const int BUZZER = 8;                                 // passive buzzer
const int SERVO_PIN = 9;                              // SG90: the "overdue" flag
const int LCD_RS = 7, LCD_E = 2, LCD_D4 = A3, LCD_D5 = A4, LCD_D6 = A5, LCD_D7 = 4;

// The kit's RGB LED is common cathode (long leg to GND). If yours lights up "inverted", set this to true.
const bool RGB_COMMON_ANODE = false;

LedControl eyesM(MAX_DIN, MAX_CLK, MAX_CS, 1);
LiquidCrystal lcd(LCD_RS, LCD_E, LCD_D4, LCD_D5, LCD_D6, LCD_D7);
Servo flag;

// ---------- eye shapes (one 8×8 matrix, two eyes) ----------
const byte EYES_OPEN[8]   = {0x00, 0x66, 0xFF, 0xFF, 0xFF, 0x66, 0x00, 0x00};
const byte EYES_LEFT[8]   = {0x00, 0x66, 0xEE, 0xEE, 0xFF, 0x66, 0x00, 0x00};
const byte EYES_RIGHT[8]  = {0x00, 0x66, 0x77, 0x77, 0xFF, 0x66, 0x00, 0x00};
const byte EYES_BLINK[8]  = {0x00, 0x00, 0x00, 0xE7, 0x00, 0x00, 0x00, 0x00};
const byte EYES_HAPPY[8]  = {0x00, 0x00, 0x42, 0xA5, 0x00, 0x00, 0x00, 0x00};   // ^ ^
const byte EYES_SLEEP[8]  = {0x00, 0x00, 0x00, 0x00, 0xE7, 0x00, 0x00, 0x00};   // _ _ (low)
const byte EYES_FOCUS[8]  = {0x00, 0x00, 0xE7, 0xE7, 0xE7, 0x00, 0x00, 0x00};   // narrow, determined
const byte EYES_ALERT[8]  = {0x66, 0xFF, 0xFF, 0xFF, 0xFF, 0x66, 0x00, 0x18};   // wide, with a dot below
const byte EYES_OFFLINE[8]= {0x00, 0x00, 0x00, 0x42, 0x24, 0x00, 0x00, 0x00};   // tired

void showEyes(const byte *rows) { for (int r = 0; r < 8; r++) eyesM.setRow(0, r, rows[r]); }

// ---------- state from the bridge ----------
String mode = "idle";
int targetR = 170, targetG = 120, targetB = 255;
float curR = 0, curG = 0, curB = 0;
long focusLeft = 0, lastFocusLeft = 0;
String line1 = "Haneul", line2 = "connecting...";
unsigned long lastState = 0;      // millis of the last S| line
String inbuf;

// ---------- knob ----------
const int CHOICES[] = {15, 25, 45, 60, 90};
const int NCHOICES = 5;
int choice = 2;                   // 45 min
unsigned long menuUntil = 0;      // while > millis(): the LCD shows the focus picker
int lastClk = HIGH;
unsigned long pressedAt = 0;
bool longSent = false;

// ---------- sound ----------
void chime() { tone(BUZZER, 1319, 90); delay(110); tone(BUZZER, 1760, 140); delay(160); noTone(BUZZER); }
void click() { tone(BUZZER, 2200, 12); }
void doneMelody() {
  const int notes[] = {1047, 1319, 1568, 2093};
  for (int i = 0; i < 4; i++) { tone(BUZZER, notes[i], 120); delay(150); }
  noTone(BUZZER);
}

// ---------- LCD ----------
String shown1, shown2;
void lcdShow(const String &a, const String &b) {
  if (a == shown1 && b == shown2) return;
  shown1 = a; shown2 = b;
  lcd.clear(); lcd.setCursor(0, 0); lcd.print(a.substring(0, 16)); lcd.setCursor(0, 1); lcd.print(b.substring(0, 16));
}

// ---------- servo flag (moved only when it changes, then detached so it doesn't buzz) ----------
int flagPos = -1;
void setFlag(bool up) {
  int want = up ? 90 : 0;
  if (want == flagPos) return;
  flagPos = want;
  flag.attach(SERVO_PIN); flag.write(want); delay(350); flag.detach();
}

void writeRGB(int r, int g, int b) {
  if (RGB_COMMON_ANODE) { r = 255 - r; g = 255 - g; b = 255 - b; }
  analogWrite(LED_R, r); analogWrite(LED_G, g); analogWrite(LED_B, b);
}

// S|mode|r|g|b|focusLeft|beep|line1|line2
void handleLine(String s) {
  s.trim();
  if (!s.startsWith("S|")) return;
  String f[9]; int n = 0, start = 0;
  for (int i = 0; i <= (int)s.length() && n < 9; i++) {
    if (i == (int)s.length() || s[i] == '|') { f[n++] = s.substring(start, i); start = i + 1; }
  }
  if (n < 9) return;
  mode = f[1];
  targetR = f[2].toInt(); targetG = f[3].toInt(); targetB = f[4].toInt();
  lastFocusLeft = focusLeft; focusLeft = f[5].toInt();
  line1 = f[7]; line2 = f[8];
  lastState = millis();
  bool beep = f[6] == "1";
  if (beep && mode != "sleep" && mode != "focus") chime();
  if (lastFocusLeft > 0 && focusLeft == 0 && mode != "sleep") doneMelody();
  setFlag(mode == "alert");
}

void setup() {
  Serial.begin(115200);
  eyesM.shutdown(0, false); eyesM.setIntensity(0, 4); eyesM.clearDisplay(0);
  pinMode(ENC_CLK, INPUT_PULLUP); pinMode(ENC_DT, INPUT_PULLUP); pinMode(ENC_SW, INPUT_PULLUP);
  pinMode(LED_R, OUTPUT); pinMode(LED_G, OUTPUT); pinMode(LED_B, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  lcd.begin(16, 2);
  lcdShow("Haneul Station", "connecting...");
  showEyes(EYES_OPEN);
  setFlag(false);
  Serial.println("HELLO");
}

unsigned long nextBlink = 3000, blinkEnd = 0, nextGlance = 6000;
const byte *glance = EYES_OPEN;

void loop() {
  unsigned long now = millis();

  // 1. lines from the bridge
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { handleLine(inbuf); inbuf = ""; }
    else if (inbuf.length() < 120) inbuf += c;
  }
  bool offline = lastState == 0 || now - lastState > 60000UL;

  // 2. the knob: turn to pick minutes, press to start, hold 1 s during a session to stop
  int clk = digitalRead(ENC_CLK);
  if (clk != lastClk && clk == LOW) {
    if (digitalRead(ENC_DT) != clk) choice = min(choice + 1, NCHOICES - 1); else choice = max(choice - 1, 0);
    menuUntil = now + 4000; click();
  }
  lastClk = clk;
  if (digitalRead(ENC_SW) == LOW) {
    if (!pressedAt) { pressedAt = now; longSent = false; }
    if (!longSent && focusLeft > 0 && now - pressedAt > 1000) { Serial.println("STOP"); longSent = true; tone(BUZZER, 660, 200); }
  } else if (pressedAt) {
    if (!longSent && now - pressedAt > 30) {
      if (focusLeft == 0 || now < menuUntil) {
        Serial.print("FOCUS "); Serial.println(CHOICES[choice]);
        tone(BUZZER, 1568, 80); menuUntil = 0;
        lcdShow("Starting focus", String(CHOICES[choice]) + " min");
      }
    }
    pressedAt = 0;
  }

  // 3. eyes
  const byte *face = EYES_OPEN;
  if (offline) face = EYES_OFFLINE;
  else if (mode == "sleep") face = EYES_SLEEP;
  else if (mode == "focus") face = EYES_FOCUS;
  else if (mode == "talk") face = EYES_HAPPY;
  else if (mode == "alert") face = ((now / 600) % 2) ? EYES_ALERT : EYES_OPEN;
  else {
    if (now > nextGlance) { glance = (random(3) == 0) ? EYES_LEFT : (random(2) ? EYES_RIGHT : EYES_OPEN); nextGlance = now + random(1500, 5000); }
    face = glance;
  }
  if (!offline && mode != "sleep" && now > nextBlink) { blinkEnd = now + 140; nextBlink = now + random(2500, 6500); }
  showEyes(now < blinkEnd ? EYES_BLINK : face);
  eyesM.setIntensity(0, mode == "sleep" ? 0 : 4);

  // 4. light: glide to the color; focus breathes slowly; talk pulses; night is dim
  float k = 0.04;
  curR += (targetR - curR) * k; curG += (targetG - curG) * k; curB += (targetB - curB) * k;
  float level = 1.0;
  if (offline) level = 0.08;
  else if (mode == "sleep") level = 0.12;
  else if (mode == "focus") level = 0.55 + 0.45 * sin(now / 1600.0);
  else if (mode == "talk") level = 0.6 + 0.4 * sin(now / 260.0);
  writeRGB((int)(curR * level), (int)(curG * level), (int)(curB * level));

  // 5. LCD: the picker while you turn the knob, otherwise her two lines
  if (now < menuUntil) lcdShow("Focus " + String(CHOICES[choice]) + " min?", "press to start");
  else if (offline) lcdShow("Haneul Station", "waiting for PC..");
  else lcdShow(line1, line2);

  delay(15);
}
