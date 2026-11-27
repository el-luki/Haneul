import { MODELS_LIGHT } from "./config.js";
import { recordGemini } from "./health.js";
import { HiccupError } from "./telegram.js";

// ---------- Gemini ----------

export async function gemini(env, contents, { system, json, models = MODELS_LIGHT, tools, lowMedia, sources } = {}) {
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  body.generationConfig = {};
  if (json) body.generationConfig.responseMimeType = "application/json";
  if (lowMedia) body.generationConfig.mediaResolution = "MEDIA_RESOLUTION_LOW"; // videos: far fewer tokens
  if (tools) body.tools = tools; // e.g. [{ url_context: {} }] lets Gemini open a web page itself

  let lastError = "";
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90000),
        });
      } catch (err) {
        lastError = `${model}: ${err.message}`;
        break; // timeout or network error: try the next model
      }
      if (res.ok) {
        let data;
        try {
          data = await res.json();
        } catch {
          lastError = `${model}: unreadable answer`; // e.g. a plain-text error page: try the next model
          break;
        }
        const text = (data.candidates?.[0]?.content?.parts || [])
          .filter((p) => !p.thought)
          .map((p) => p.text || "")
          .join("")
          .trim();
        if (text) {
          await recordGemini(env, model, "ok");
          if (sources) for (const g of data.candidates?.[0]?.groundingMetadata?.groundingChunks || []) if (g.web?.uri) sources.push({ title: g.web.title || "", url: g.web.uri });
          return text;
        }
        lastError = `${model}: empty answer`;
        break;
      }
      lastError = `${model}: HTTP ${res.status}`;
      if (res.status === 429) await recordGemini(env, model, "limited");
      // 429 = this model's quota is used up: retrying won't help, go straight to the next model.
      // 500/502/503/504 = temporarily busy or timed out: wait a moment and retry once.
      if (![500, 502, 503, 504].includes(res.status)) break;
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw new HiccupError(`Gemini is overloaded right now (${lastError})`);
}

// Reads JSON from a Gemini answer even when it adds extra text around it, like
// ```json fences or a second object after the first (that crashed the Korean lesson).
// Takes the first complete {...} or [...] block, respecting strings and escapes.
export function parseJson(raw) {
  const text = String(raw);
  const start = text.search(/[{[]/);
  if (start < 0) throw new Error("the AI's answer had no JSON in it");
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        const chunk = text.slice(start, i + 1);
        try {
          return JSON.parse(chunk);
        } catch (err) {
          const fixed = repairJson(chunk);
          if (fixed !== chunk) return JSON.parse(fixed);
          throw err;
        }
      }
    }
  }
  throw new Error("the AI's answer was cut off");
}

// Small mistakes Gemini sometimes makes in JSON (seen: ="text" inside a list, trailing commas).
export function repairJson(s) {
  return s
    .replace(/([[,:]\s*)=\s*"/g, '$1"') // ="text" → "text"
    .replace(/,\s*([\]}])/g, "$1") // trailing commas
    .replace(/[“”]/g, '"'); // curly quotes used as JSON quotes
}

// Upload raw bytes (a video or voice note) to Gemini's Files API without converting them to
// base64 (that would blow the free 10 ms CPU limit), wait until processed, and return the part
// to put in a prompt. body can be an ArrayBuffer or a stream (then length must be given).
export async function geminiUpload(env, body, { length, mime, name = "upload" }) {
  const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(length),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: name } }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error(`upload failed to start (${start.status})`);
  const up = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Length": String(length) },
    body,
  });
  const info = (await up.json().catch(() => ({}))).file;
  if (!info?.name) throw new Error("upload failed");
  return info;
}

// Waits until an uploaded file is ready (videos take a while; audio is usually instant).
export async function geminiFileReady(env, info, tries = 30) {
  for (let i = 0; i < tries && info.state === "PROCESSING"; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    info = await fetch(`https://generativelanguage.googleapis.com/v1beta/${info.name}`, { headers: { "x-goog-api-key": env.GEMINI_API_KEY } }).then((r) => r.json());
  }
  if (info.state !== "ACTIVE") throw new Error("Gemini couldn't process the file");
  return { fileData: { fileUri: info.uri, mimeType: info.mimeType } };
}

export function geminiDelete(env, part) {
  const name = part?.fileData?.fileUri?.split("/v1beta/")[1];
  if (name) fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, { method: "DELETE", headers: { "x-goog-api-key": env.GEMINI_API_KEY } }).catch(() => {});
}
