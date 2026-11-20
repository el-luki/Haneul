"""Korean pronunciation: turn a lesson's words into a Telegram voice message.

Gemini's text-to-speech returns raw audio (PCM); Telegram voice messages must be
OGG/Opus, so ffmpeg converts it. That's why this runs on GitHub (ffmpeg is
available there) instead of in the bot. The bot starts it after each Korean lesson.

Inputs (environment): SPEAK = the Korean text to read, CAPTION = message caption.
Run locally (needs ffmpeg):  set SPEAK=안녕하세요 && py korean_audio.py
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import uuid
import wave
from pathlib import Path

import brief

TTS_MODELS = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"]
VOICE = "Kore"  # a clear, calm prebuilt Gemini voice


def tts(text):
    """Returns raw 24 kHz 16-bit mono PCM bytes."""
    prompt = (
        "Read this slowly and clearly, like a friendly Korean teacher speaking to a total beginner. "
        "Pause for a moment between items, and say each Korean item exactly as written:\n\n" + text
    )
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOICE}}},
        },
    }
    last = ""
    for model in TTS_MODELS:
        req = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"]},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
            for part in data["candidates"][0]["content"]["parts"]:
                if "inlineData" in part:
                    return base64.b64decode(part["inlineData"]["data"])
            last = f"{model}: no audio in the answer"
        except Exception as exc:
            last = f"{model}: {exc}"
            print(f"TTS failed with {last}", file=sys.stderr)
    raise RuntimeError(f"text-to-speech unavailable ({last})")


def to_ogg(pcm, folder):
    wav_path = Path(folder) / "speech.wav"
    ogg_path = Path(folder) / "speech.ogg"
    with wave.open(str(wav_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm)
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav_path), "-c:a", "libopus", "-b:a", "32k", str(ogg_path)],
        check=True,
    )
    return ogg_path


def send_voice(ogg_path, caption):
    """Through the bot first (so the app gets it too); else Telegram sendVoice with a
    hand-made multipart body (no extra libraries)."""
    if brief.relay({"voice": base64.b64encode(Path(ogg_path).read_bytes()).decode(), "caption": caption}):
        return
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in (("chat_id", os.environ["TELEGRAM_CHAT_ID"]), ("caption", caption)):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="voice"; filename="korean.ogg"\r\n'
        f"Content-Type: audio/ogg\r\n\r\n".encode() + Path(ogg_path).read_bytes() + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{os.environ['TELEGRAM_BOT_TOKEN']}/sendVoice",
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        if not json.loads(resp.read()).get("ok"):
            raise RuntimeError("Telegram refused the voice message")


if __name__ == "__main__":
    brief.load_env()
    speak = os.environ.get("SPEAK", "").strip()
    caption = os.environ.get("CAPTION", "").strip() or "🔊 Listen and repeat"
    if not speak:
        sys.exit("Nothing to say (SPEAK is empty).")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            send_voice(to_ogg(tts(speak[:1500]), tmp), caption[:1000])
        print("Voice message sent.")
    except Exception as exc:
        brief.send_telegram(f"🔊 Couldn't make the pronunciation audio this time ({exc}).")
        raise
