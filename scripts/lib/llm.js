import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEFAULT_MODEL = "deepseek-chat";

function parseEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

export function loadEnv() {
  parseEnvFile(join(ROOT, ".env"));
  parseEnvFile(join(ROOT, ".env.local"));
}

export function hasLLMKey() {
  loadEnv();
  return !!process.env.DEEPSEEK_API_KEY;
}

export function getProviderInfo() {
  loadEnv();
  return {
    provider: "DeepSeek",
    model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
  };
}

export function contentHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function unescapeJsonString(s) {
  try {
    return JSON.parse(`"${s.replace(/"/g, '\\"')}"`);
  } catch {
    return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function extractFields(content) {
  const briefMatch = content.match(/"brief"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const fullMatch = content.match(/"full"\s*:\s*"((?:[^"\\]|\\.)*)"/s);

  if (briefMatch && fullMatch) {
    return {
      brief: unescapeJsonString(briefMatch[1]),
      full: unescapeJsonString(fullMatch[1]),
    };
  }

  const blockMatch = content.match(/\{[\s\S]*"brief"\s*:\s*"([^"]*)"[\s\S]*"full"\s*:\s*"([\s\S]*?)"\s*\}/);
  if (blockMatch) {
    return {
      brief: unescapeJsonString(blockMatch[1]),
      full: unescapeJsonString(blockMatch[2]),
    };
  }

  return null;
}

function parseJsonResponse(content) {
  let text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();

  try {
    const parsed = JSON.parse(text);
    if (parsed.brief && parsed.full) return parsed;
  } catch {
    // continue
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed.brief && parsed.full) return parsed;
    } catch {
      // continue
    }
  }

  const extracted = extractFields(text);
  if (extracted?.brief && extracted?.full) return extracted;

  throw new Error("Model returned invalid JSON");
}

async function callLLMOnce({ system, user, json }) {
  loadEnv();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY not set. Add it to .env.local");
  }

  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      response_format: json ? { type: "json_object" } : undefined,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const content = data.choices[0]?.message?.content ?? "";
  return json ? parseJsonResponse(content) : content;
}

export async function callLLM({ system, user, json = true }) {
  const retrySystem = `${system}

IMPORTANT: Return compact valid JSON only. Use \\n\\n (escaped) for paragraph breaks inside "full". No markdown fences.`;

  try {
    return await callLLMOnce({ system, user, json });
  } catch (firstErr) {
    if (!json) throw firstErr;
    try {
      return await callLLMOnce({
        system: retrySystem,
        user: `${user}\n\nPrevious attempt failed JSON parsing. Return {"brief":"...","full":"..."} with \\n\\n between paragraphs.`,
        json,
      });
    } catch {
      throw firstErr;
    }
  }
}
