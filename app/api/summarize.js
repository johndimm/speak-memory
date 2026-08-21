// Vercel serverless function — turns a raw journal text box into {brief, full}.
// The DeepSeek key lives in this function's env (DEEPSEEK_API_KEY), never in the browser.

const API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";

const DAY_SYSTEM = `You are an editor turning voice-memo journal entries into readable prose.
The source is messy speech-to-text. Your job is to compress and polish it — NOT to paraphrase every thought.

Return ONLY valid JSON: {"brief":"...","full":"..."}

- brief: one sentence, past tense, max 20 words — the headline of what happened
- full: 3-4 SHORT paragraphs (2-4 sentences each). Separate with \\n\\n in the JSON string.
  Calm, lightly-edited voice.
  Cut repetition, filler, false starts, and meta-commentary about journaling itself.
  Keep: people, events, places, decisions, emotions, and specific details worth remembering.
  Target 150-250 words total for full.

TENSE — you are given the entry's date and the local time it was written. Match tense to when
things actually occur relative to that moment; do not force everything into one tense:
- Entry dated BEFORE the current date: a past day — use past tense throughout.
- Entry for TODAY, written in the MORNING / early: mostly PLANS for the day ahead. Write intended
  activities as plans or intentions ("plans to…", "hopes to…") — do NOT narrate them as done.
- Entry for TODAY, written MIDDAY / during the day: often about ONGOING or just-finished events.
  Use present or present-progressive for what's happening now ("is…", "is doing…"), past for what's
  already wrapped up, and plans/intentions for what's still ahead.
- Entry written in the EVENING / late: use past tense for what happened.
- Any entry can mix done, in-progress, and planned. Preserve those distinctions precisely: never
  state a planned or in-progress thing as completed.`;

const LIFE_SYSTEM = `You are distilling a person's entire journal — their life as recorded so far — into four nested scales, like an epitaph.
Return ONLY valid JSON with no markdown: {"paragraph":"...","sentence":"...","phrase":"...","word":"..."}
- paragraph: 3-5 sentences, in the FIRST PERSON ("I …"), on the arc, themes, people, and spirit of my life.
- sentence: one first-person sentence that captures the whole.
- phrase: 2 to 5 words, evocative.
- word: a single word.
Draw ONLY on what the entries actually show. Be honest, humane, and specific — not grandiose or clichéd.
Escape any double quotes inside strings with a backslash.`;

const MEMORIES_SYSTEM = `You read a piece of writing and extract each distinct PAST memory that carries a time indicator, resolving each to a span of years. This is a FAST extraction — do NOT write prose or outlines, just pin down what and when.
Return ONLY valid JSON: {"memories":[{"startYear":<int|null>,"endYear":<int|null>,"label":"<short time label>","text":"<the memory>"}]}
- A "time indicator" locates the memory in time: "when I was five", "in 1959", "the summer after college", "back in the 80s", "during the war", "my wedding year".
- Resolve ages with the writer's birth year: "when I was five" → that year (start=end); "my 20s" → ages 20–29; "high school" → roughly ages 14–18.
- "in 1959" → 1959..1959. "the 1980s" → 1980..1989. If it cannot be pinned to any year (e.g. "a long time ago", or an age with no birth year), use null for both — it attaches to the whole life.
- CONSOLIDATE. Group recollections about the same person, relationship, place, or one continuous episode/period into a SINGLE memory — even when the writing rambles across many small details. Strongly prefer a FEW substantial memories over many tiny fragments; split only when events are genuinely separate in time or subject. Most inputs yield one memory, or a handful — rarely more than 3-4.
- "text": a self-contained account of that memory — a sentence or a few — keeping the vivid specifics but dropping present-day asides ("I'll add more later", "I can't remember").
- "label": a short human phrase for the time, e.g. "1959", "the 1970s", "your 20s (1974–1983)", "sometime in life".
- Ignore the present, the future, and passages with no time indicator. If there are none, return {"memories":[]}.`;

const LEVELS_SYSTEM = `You distill a piece of writing into a ladder of summaries — each level a little fuller than the one before — plus a nested outline, so a reader can zoom from a single word all the way down to the full text.
Return ONLY valid JSON with these keys:
{"word":"...","phrase":"...","sentence":"...","paragraph":"...","summary":"...","outline":"..."}
- word: ONE evocative word for the whole.
- phrase: 2–5 words.
- sentence: a single sentence capturing the whole.
- paragraph: one short paragraph (3–5 sentences).
- summary: the complete summary — 2–4 SHORT paragraphs separated by \\n\\n; cover the people, events, feelings, and threads worth remembering.
- outline: a REAL nested outline — every line starts with "- ", indent exactly 2 spaces per level, 1–3 levels as the material warrants; leaf bullets MAY be a sentence. Single newlines between bullets, no blank lines.
Escape any double quotes inside strings with a backslash.`;

// The cheap distilled rungs only — fast, so a leaf page lands in a couple of seconds. The
// heavy "summary" and "outline" are generated lazily (DETAIL_SYSTEM) when a reader expands them.
const RUNGS_SYSTEM = `You distill a piece of writing into a short ladder of summaries, each level a little fuller than the one before.
Return ONLY valid JSON with these keys:
{"word":"...","phrase":"...","sentence":"...","paragraph":"..."}
- word: ONE evocative word for the whole.
- phrase: 2–5 words.
- sentence: a single sentence capturing the whole.
- paragraph: one short paragraph (3–5 sentences).
Escape any double quotes inside strings with a backslash.`;

// The heavy long-form outputs, generated on demand when a reader opens the folds.
const DETAIL_SYSTEM = `You expand a piece of writing into a complete summary and a nested outline.
Return ONLY valid JSON with these keys:
{"summary":"...","outline":"..."}
- summary: the complete summary — 2–4 SHORT paragraphs separated by \\n\\n; cover the people, events, feelings, and threads worth remembering.
- outline: a REAL nested outline — every line starts with "- ", indent exactly 2 spaces per level, 1–3 levels as the material warrants; leaf bullets MAY be a sentence. Single newlines between bullets, no blank lines.
Escape any double quotes inside strings with a backslash.`;

const LEVEL_DEFS = `Each node's "levels" object has: {"word","phrase","sentence","paragraph","summary","outline","rewrite"}
- word: ONE evocative word. phrase: 2–5 words. sentence: one sentence. paragraph: one short paragraph (3–5 sentences).
- summary: the complete summary, 2–4 short paragraphs separated by \\n\\n.
- outline: a nested outline — every line starts "- ", 2-space indent per level, 1–3 levels; single newlines between bullets.
- rewrite: for a LEAF only, a faithful retelling that condenses nothing (every remark appears); for roll-up nodes set "".`;

const SPINE_SYSTEM = `You update a short chain of nested summaries in a single pass, following a dependency plan so a parent is only summarized after its children.
You are given a LEAF (raw first-person writing) and a bottom-up CHAIN of ancestor nodes. Each ancestor is summarized from the PARAGRAPH summaries of its children: some children you compute here (named in its "from", each being "leaf" or an earlier node's key) and some are supplied already-summarized (its "others" list of paragraphs).
DO THIS IN ORDER:
1. Summarize the LEAF into all levels.
2. For each CHAIN node top-to-bottom of the list: collect the paragraph of every node named in "from" (already produced above) PLUS every string in "others", and summarize them into all levels for that node.
${LEVEL_DEFS}
Write prose in the FIRST PERSON, past tense. Return ONLY valid JSON: {"leaf":{...levels...},"nodes":{"<key>":{...levels...}, ...}}. Escape double quotes with a backslash.`;

const MEMORIES_REFINE_SYSTEM = `You are correcting a list of memories extracted from a person's (often messy, mis-transcribed) writing.
You are given: the original writing, the CURRENT list of memories as JSON, and an INSTRUCTION describing what to change — fixing a date or age, correcting a misheard word, merging or splitting entries, dropping one, rewording, etc.
Apply ONLY what the instruction asks; leave every other memory exactly as it is. If the instruction changes when something happened, re-resolve its years/label (use the birth year for ages).
Return ONLY valid JSON, the full revised list, SAME shape: {"memories":[{"startYear":<int|null>,"endYear":<int|null>,"label":"<short time label>","text":"<the memory>"}]}
This is fast bookkeeping — do NOT write prose or outlines. If the list becomes empty, return {"memories":[]}.`;

const MEMORY_WRITEUP_SYSTEM = `You are given a single PAST memory (a short factual statement) and you write it up in the first person.
Return ONLY valid JSON: {"prose":{"brief":"<one sentence>","full":"<1-2 short paragraphs>"},"outline":{"brief":"<one line>","full":"<nested bullet outline>"}}
- First person, past tense: "I moved to Elm Street", never "the speaker"/"the writer".
- prose.full: 1–2 short paragraphs re-telling the memory. prose.brief: one sentence headline.
- outline.full: a REAL nested outline — every line begins "- ", indent exactly 2 spaces per level, 1–3 levels as the material warrants; leaf bullets may be a sentence. outline.brief: one-line headline.
- Keep every fact accurate. Escape any double quotes inside strings with a backslash.`;

const GENERATE_SYSTEM = `You invent a plausible, richly-specific JOURNAL for a famous subject — a real person, or a collective/entity (a band, a show, a country, a company). It is written in the FIRST PERSON, as if the subject kept a diary across their whole existence: affectionate, vivid, grounded in the real public record, but imagined in voice and interior detail.

Return ONLY valid JSON with no markdown:
{"meta":{"title":"<name>","kind":"person"|"entity","startYear":<int>,"birthYear":<int|null>,"grouping":"life"|"calendar"},"memories":[{"category":"<a few words>","subject":"<person/place/work>","startYear":<int>,"endYear":<int|null>,"label":"<short time label>","text":"<first-person recollection, 2-5 sentences>"}],"entries":[{"date":"YYYY-MM-DD","text":"<first-person diary entry for that day, 3-6 sentences>"}]}

RULES:
- kind: "person" for an individual human; "entity" for a band, show, country, company, or other collective.
- PERSON: grouping="life", birthYear=their real birth year, startYear=birthYear. Cover the arc — childhood, family, the places lived, the work/roles, the key relationships, the turning points, later years. GROUP memories into 4-7 CATEGORIES (e.g. "Family","Places","Films","Music","Relationships","Turning points"). Each memory gets a real span of years.
- ENTITY: grouping="calendar", birthYear=null, startYear=the founding/origin year. Memories are eras, works, members, milestones grouped into categories (e.g. "Albums","Tours","Lineup","Milestones"). Use a natural first-person-collective voice.
- MEMORIES: 12-16, spread across the whole span — the biographical backbone. Each "text" is a self-contained first-person recollection with concrete REAL specifics (names, places, years), not a summary.
- ENTRIES: 6-9 dated diary entries on ICONIC days (a premiere, an election, a release, a breakup). "date" is a real-ish date within the subject's life; "text" is looser and intimate, in the moment.
- Stay recognizably true to the real public record. Be warm and specific; avoid cliché. For living people keep it dignified and plausible — nothing defamatory or salacious.
- Escape any double quotes inside strings with a backslash.`;

const PERIOD_SYSTEM = `You summarize journal entries spanning multiple days.
Return ONLY valid JSON with no markdown: {"brief":"...","full":"..."}
- brief: one sentence overview
- full: 2-4 SHORT paragraphs (2-4 sentences each) on themes, people, and what happened. Separate paragraphs with \\n\\n in the JSON string — never one long block.
Escape any double quotes inside strings with backslash.`;

const MAX_PARAGRAPH_CHARS = 320;

function outlineDirective() {
  return `\n\nOUTPUT SHAPE — Write "full" as a REAL NESTED OUTLINE (not paragraphs, not a flat list):` +
    `\n- Begin every line with "- ".` +
    `\n- Indent exactly 2 spaces per level.` +
    `\n- YOU choose the depth from the material: use 2 levels for most days, add a 3rd level where a topic has rich sub-detail, and stay shallow (even 1 level) for simple days. Group related details under parent topics — don't return a flat list when there's real structure.` +
    `\n- Parent bullets are short topic labels; leaf bullets (deepest, no children) MAY be a sentence or two of prose.` +
    `\n- One bullet per line, single newlines between bullets, no blank lines.` +
    `\n\nExample:\n- Yard work\n  - Mapped the sprinkler heads\n    - Found two dead zones near the fence.\n- Google billing\n  - Still owes about $750 and is holding off until they respond.` +
    `\n\n"brief" stays a one-line headline. This overrides the "3-4 paragraphs" instruction.`;
}

const FIRST_PERSON_NOTE = `\n\nPERSON — Write the prose ("brief" and "full") in the FIRST PERSON, as the person whose journal this is ("I went…", "I felt…", "I decided…"). Never refer to them as "the speaker", "the writer", or "the author".`;

function styleDirective(style) {
  if (!style) return "";
  return `\n\nVOICE OVERRIDE — Rewrite both "brief" and "full" FROM SCRATCH in the unmistakable prose style ` +
    `of ${style}: their characteristic diction, sentence rhythm, imagery, humor, and tone. Commit fully — ` +
    `do not merely lightly edit or echo the input wording; re-tell it as ${style} would. Keep every fact ` +
    `accurate and obey the tense rules. This takes precedence over the neutral editorial-voice instruction. ` +
    `Still return strictly valid JSON regardless of the style's punctuation habits.`;
}

function structureFull(text) {
  let t = String(text).replace(/\\n/g, "\n").trim();
  let paras = t.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

  const splitLong = (para) => {
    if (para.length <= MAX_PARAGRAPH_CHARS) return [para];
    const sentences = para.match(/[^.!?]+[.!?]+(?:\s+|$)/g) || [para];
    const chunks = [];
    let current = "";
    for (const s of sentences) {
      if (current.length + s.length > MAX_PARAGRAPH_CHARS && current) {
        chunks.push(current.trim());
        current = s;
      } else {
        current += s;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length ? chunks : [para];
  };

  paras = paras.flatMap(splitLong);

  if (paras.length < 3 && t.length > 350) {
    const sentences = t.match(/[^.!?]+[.!?]+(?:\s+|$)/g) || [t];
    const target = Math.min(4, Math.max(3, Math.ceil(sentences.length / 3)));
    const size = Math.ceil(sentences.length / target);
    paras = [];
    for (let i = 0; i < sentences.length; i += size) {
      paras.push(sentences.slice(i, i + size).join("").trim());
    }
  }

  return paras.filter(Boolean).join("\n\n");
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
    return { brief: unescapeJsonString(briefMatch[1]), full: unescapeJsonString(fullMatch[1]) };
  }
  return null;
}

function hasKeys(o, keys) { return o && keys.every((k) => typeof o[k] === "string" && o[k].trim()); }

function parseJsonResponse(content, keys = ["brief", "full"]) {
  let text = String(content).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();

  try { const p = JSON.parse(text); if (hasKeys(p, keys)) return p; } catch { /* continue */ }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { const p = JSON.parse(text.slice(start, end + 1)); if (hasKeys(p, keys)) return p; } catch { /* continue */ }
  }

  if (keys.length === 2 && keys[0] === "brief" && keys[1] === "full") {
    const extracted = extractFields(text);
    if (hasKeys(extracted, keys)) return extracted;
  }

  throw new Error("Model returned invalid JSON");
}

// Resolve the model/key/endpoint/provider for a request: the caller's own (from Settings) takes
// precedence, else the server's env. "anthropic" uses the Anthropic API; everything else is
// OpenAI-compatible (DeepSeek default, OpenAI, OpenRouter, …) via baseUrl (…/v1).
function llmConfig(body) {
  const provider = (body.provider || "").trim();
  const defaultBase = provider === "openai" ? "https://api.openai.com/v1" : "https://api.deepseek.com/v1";
  const base = String(body.baseUrl || defaultBase).trim().replace(/\/+$/, "");
  return {
    provider,
    apiKey: (body.apiKey || "").trim() || process.env.DEEPSEEK_API_KEY,
    model: (body.model || "").trim() || process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
    url: base + "/chat/completions",
  };
}

// One completion → the model's raw text. Anthropic uses its Messages API (system as a top-level
// param, x-api-key header, and a "{" prefill to force a JSON reply); every other provider is
// OpenAI-compatible (chat/completions with response_format json_object).
async function rawComplete(cfg, system, user, temperature) {
  const apiKey = cfg.apiKey || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("No API key — add your own in Settings, or set DEEPSEEK_API_KEY on the server.");
  const model = cfg.model || process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  if (cfg.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: cfg.maxTokens || 4096, temperature: Math.min(1, temperature), system, messages: [{ role: "user", content: user }, { role: "assistant", content: "{" }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return "{" + (data.content?.[0]?.text ?? ""); // prepend the prefilled "{"
  }
  const res = await fetch(cfg.url || API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`LLM API error ${res.status}: ${await res.text()}`);
  return (await res.json()).choices?.[0]?.message?.content ?? "";
}

async function callLLMOnce(system, user, temperature = 0.3, keys = ["brief", "full"], cfg = {}) {
  return parseJsonResponse(await rawComplete(cfg, system, user, temperature), keys);
}

async function callLLM(system, user, temperature = 0.3, keys = ["brief", "full"], cfg = {}) {
  try {
    return await callLLMOnce(system, user, temperature, keys, cfg);
  } catch (firstErr) {
    try {
      return await callLLMOnce(
        `${system}\n\nIMPORTANT: Return compact valid JSON only with exactly these keys: ${keys.map((k) => `"${k}"`).join(", ")}. No markdown fences.`,
        `${user}\n\nPrevious attempt failed JSON parsing. Return valid JSON.`,
        temperature,
        keys,
        cfg,
      );
    } catch {
      throw firstErr;
    }
  }
}

// Parse a JSON object out of a model reply, tolerating markdown fences, surrounding text,
// and stray control characters inside strings. Throws a clear error if nothing parses.
function parseJsonObject(raw) {
  let txt = String(raw ?? "").trim();
  const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) txt = fenced[1].trim();
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  const candidate = s !== -1 && e > s ? txt.slice(s, e + 1) : txt;
  const attempts = [candidate];
  // Repair unescaped control chars (raw newlines/tabs) that the model sometimes leaves in.
  attempts.push(candidate.replace(/[\u0000-\u001f]+/g, " "));
  for (const a of attempts) {
    try { return JSON.parse(a); } catch { /* try next */ }
  }
  throw new Error("Model returned invalid JSON");
}

async function callJsonObjectOnce(system, user, temperature, cfg = {}) {
  return parseJsonObject(await rawComplete(cfg, system, user, temperature));
}

// List the chat models a provider offers (for the Settings picker). Anthropic and OpenAI both
// expose GET /v1/models; the response ids are what the model dropdown is populated with.
async function listModels(body) {
  const provider = (body.provider || "").trim();
  const apiKey = (body.apiKey || "").trim();
  if (!apiKey) throw new Error("Enter your API key first.");
  let url, headers;
  if (provider === "anthropic") {
    url = "https://api.anthropic.com/v1/models?limit=100";
    headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  } else {
    const base = String(body.baseUrl || (provider === "openai" ? "https://api.openai.com/v1" : "https://api.deepseek.com/v1")).trim().replace(/\/+$/, "");
    url = base + "/models";
    headers = { Authorization: `Bearer ${apiKey}` };
  }
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200);
    const seen = `[received ${apiKey.length}-char key starting "${apiKey.slice(0, 7)}…"]`;
    throw new Error(`${new URL(url).host} said ${r.status}: ${body || "(no detail)"} ${seen} — check the key matches the "${provider || "(built-in)"}" provider.`);
  }
  const data = await r.json();
  // Providers expose an id and a creation date (Anthropic also a display name), but NOT pricing.
  return (data.data || data.models || []).map((m) => ({
    id: m.id || m.name,
    name: m.display_name || "",
    created: m.created_at || (m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : ""),
  })).filter((m) => m.id);
}

async function callJsonObject(system, user, temperature = 0.2, cfg = {}) {
  try {
    return await callJsonObjectOnce(system, user, temperature, cfg);
  } catch (firstErr) {
    try {
      return await callJsonObjectOnce(
        `${system}\n\nIMPORTANT: Reply with ONE strictly valid JSON object and nothing else — no markdown fences, no text before or after, and escape every newline inside a string as \\n.`,
        `${user}\n\nThe previous reply was not valid JSON. Return only the JSON object.`,
        temperature,
        cfg,
      );
    } catch { throw firstErr; }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const mode = body.mode || "day";
    const cfg = llmConfig(body); // caller's own key/model/endpoint, else the server's env

    if (mode === "models") {
      try { res.status(200).json({ models: await listModels(body) }); }
      catch (e) { res.status(400).json({ error: e.message }); }
      return;
    }

    // Invent a whole journal for a famous subject — meta + memories + a few dated entries. The
    // client drops these into an isolated journal DB and the normal background pass summarizes them.
    if (mode === "generate") {
      const subject = String(body.subject || "").trim();
      if (!subject) { res.status(400).json({ error: "No subject given" }); return; }
      const hint = body.kindHint ? `\n\nThe user suggests this is a ${body.kindHint}.` : "";
      const r = await callJsonObject(GENERATE_SYSTEM, `Subject: ${subject}${hint}\n\nInvent the journal now.`, 0.85, { ...cfg, maxTokens: 8192 });
      const int = (v) => (Number.isFinite(v) ? Math.round(v) : (Number.isFinite(+v) ? Math.round(+v) : null));
      const str = (v, d = "") => (typeof v === "string" ? v.trim() : d);
      const m = r.meta || {};
      const kind = m.kind === "entity" ? "entity" : "person";
      const birthYear = int(m.birthYear);
      const startYear = int(m.startYear) ?? birthYear ?? null;
      const meta = {
        title: str(m.title, subject),
        kind,
        startYear,
        birthYear: kind === "person" ? birthYear : null,
        grouping: m.grouping === "calendar" ? "calendar" : (kind === "person" ? "life" : "calendar"),
      };
      const memories = (Array.isArray(r.memories) ? r.memories : [])
        .filter((x) => x && str(x.text))
        .map((x) => ({ category: str(x.category, "Life"), subject: str(x.subject), startYear: int(x.startYear), endYear: int(x.endYear ?? x.startYear), label: str(x.label, "sometime"), text: str(x.text) }));
      const entries = (Array.isArray(r.entries) ? r.entries : [])
        .filter((x) => x && str(x.text) && /^\d{4}-\d{2}-\d{2}$/.test(str(x.date)))
        .map((x) => ({ date: str(x.date), text: str(x.text) }));
      if (!memories.length && !entries.length) { res.status(502).json({ error: "The model returned nothing usable — try again." }); return; }
      res.status(200).json({ meta, memories, entries });
      return;
    }

    if (mode === "memories" || mode === "memories-refine") {
      const { text = "", birthYear = null, today = "" } = body;
      if (!text.trim()) { res.status(400).json({ error: "No text provided" }); return; }
      const context = `Today is ${today}.${birthYear ? ` The writer was born in ${birthYear}.` : ""}`;

      let system, user;
      if (mode === "memories-refine") {
        const current = Array.isArray(body.memories) ? body.memories : [];
        const instruction = String(body.instruction || "").slice(0, 2000);
        if (!instruction.trim()) { res.status(400).json({ error: "No instruction provided" }); return; }
        system = MEMORIES_REFINE_SYSTEM;
        user = `${context}\n\nOriginal writing:\n${String(text).slice(0, 12000)}\n\nCurrent memories (JSON):\n${JSON.stringify(current).slice(0, 8000)}\n\nInstruction:\n${instruction}`;
      } else {
        system = MEMORIES_SYSTEM;
        user = `${context}\n\nWriting:\n${String(text).slice(0, 12000)}`;
      }

      const r = await callJsonObject(system, user, 0.2, cfg);
      const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);
      const str = (v, d = "") => (typeof v === "string" ? v.trim() : d);
      const memories = (Array.isArray(r.memories) ? r.memories : [])
        .filter((m) => m && typeof m.text === "string" && m.text.trim())
        .map((m) => ({ startYear: int(m.startYear), endYear: int(m.endYear ?? m.startYear), label: str(m.label, "sometime in life"), text: m.text.trim() }));
      res.status(200).json({ memories });
      return;
    }

    // Turn one saved memory into first-person prose + outline (done in the background
    // after the memory is stored, so saving stays instant). Voice applies to prose only.
    if (mode === "memory-writeup") {
      const { text = "", style = "" } = body;
      if (!text.trim()) { res.status(400).json({ error: "No text provided" }); return; }
      const styleLine = style
        ? `\n\nVOICE — write the "prose" fields ONLY (never the outline) in the unmistakable style of ${style}: their diction, rhythm, and tone, fully committed, first person, every fact intact.`
        : "";
      const user = `Memory:\n${String(text).slice(0, 4000)}${styleLine}`;
      const r = await callJsonObject(MEMORY_WRITEUP_SYSTEM, user, 0.2, cfg);
      const str = (v, d = "") => (typeof v === "string" ? v.trim() : d);
      const rep = (o) => (o && typeof o === "object" && str(o.full) ? { brief: str(o.brief), full: str(o.full) } : null);
      res.status(200).json({ prose: rep(r.prose), outline: rep(r.outline) });
      return;
    }

    if (mode === "life") {
      const { days = [], style = "" } = body;
      if (!days.length) {
        res.status(400).json({ error: "No entries to distill" });
        return;
      }
      const combined = days.map((d) => `${d.date}: ${d.brief}`).join("\n").slice(0, 18000);
      const voice = style ? `\n\nWrite all four fields in the unmistakable prose voice of ${style}.` : "";
      const keys = ["paragraph", "sentence", "phrase", "word"];
      const result = await callLLM(LIFE_SYSTEM + voice, `The journal so far, one line per day:\n\n${combined}`, style ? 0.85 : 0.6, keys, cfg);
      res.status(200).json({ paragraph: result.paragraph, sentence: result.sentence, phrase: result.phrase, word: result.word });
      return;
    }

    if (mode === "period") {
      const { type = "week", label = "", days = [], style = "", format = "prose" } = body;
      if (!days.length) {
        res.status(400).json({ error: "No days to summarize" });
        return;
      }
      const combined = days.map((d) => `${d.date}: ${d.brief}\n${d.full}`).join("\n\n");
      const sys = PERIOD_SYSTEM + (format === "outline" ? outlineDirective() : FIRST_PERSON_NOTE) + styleDirective(style);
      const result = await callLLM(sys, `${type} summary for ${label}:\n\n${combined.slice(0, 16000)}`, style ? 0.8 : 0.3, undefined, cfg);
      // Split a long prose block into readable paragraphs (the outline keeps its own lines).
      const full = format === "outline" ? result.full : structureFull(result.full);
      res.status(200).json({ brief: result.brief, full });
      return;
    }

    // Multi-level summary: one call returns word→phrase→sentence→paragraph→complete summary
    // + outline (+ a no-condense rewrite for leaf nodes). Used by every node in the Journal.
    if (mode === "levels") {
      const { text = "", type = "node", label = "", style = "", subject = "", date = "", localTime = "", distilled = false, correction = "" } = body;
      if (!text.trim()) { res.status(400).json({ error: "No text provided" }); return; }
      const subjectNote = subject
        ? `\n\nSUBJECT — This is about "${subject}". Use exactly that name and spelling for it throughout, correcting any mis-transcription. It may be a person, place, or thing.`
        : "";
      const correctionNote = correction
        ? `\n\nCORRECTION — The reader flagged a previous summary as wrong. Apply and honor this correction: ${String(correction).slice(0, 1000)}`
        : "";
      const ctx = `Context: ${type}${label ? ` — ${label}` : ""}${date ? `, ${date}` : ""}${localTime ? ` (written ${localTime})` : ""}.`;
      const user = `${ctx}\n\nText:\n\n${String(text).slice(0, 16000)}`;
      const s = (v) => (typeof v === "string" ? v.trim() : "");
      // Fast path: just the distilled rungs (leaves use this; summary/outline come later, lazily).
      if (distilled) {
        const sys = RUNGS_SYSTEM + FIRST_PERSON_NOTE + subjectNote + correctionNote + styleDirective(style);
        const r = await callLLM(sys, user, style ? 0.8 : 0.4, ["word", "phrase", "sentence", "paragraph"], cfg);
        res.status(200).json({ word: s(r.word), phrase: s(r.phrase), sentence: s(r.sentence), paragraph: s(r.paragraph), summary: "", outline: "" });
        return;
      }
      // Full ladder (roll-ups): distilled rungs + complete summary + outline.
      const sys = LEVELS_SYSTEM + FIRST_PERSON_NOTE + subjectNote + correctionNote + styleDirective(style);
      const r = await callLLM(sys, user, style ? 0.8 : 0.4, ["word", "phrase", "sentence", "paragraph", "summary"], cfg);
      res.status(200).json({
        word: s(r.word), phrase: s(r.phrase), sentence: s(r.sentence),
        paragraph: s(r.paragraph), summary: structureFull(s(r.summary)), outline: s(r.outline),
      });
      return;
    }

    // Lazy detail: the heavy complete-summary + outline for a leaf, generated when the reader
    // opens those folds (keeps the leaf's first summarization fast).
    if (mode === "detail") {
      const { text = "", type = "node", label = "", style = "", subject = "", date = "", localTime = "", correction = "" } = body;
      if (!text.trim()) { res.status(400).json({ error: "No text provided" }); return; }
      const subjectNote = subject
        ? `\n\nSUBJECT — This is about "${subject}". Use exactly that name and spelling for it throughout, correcting any mis-transcription. It may be a person, place, or thing.`
        : "";
      const correctionNote = correction
        ? `\n\nCORRECTION — The reader flagged a previous summary as wrong. Apply and honor this correction: ${String(correction).slice(0, 1000)}`
        : "";
      const sys = DETAIL_SYSTEM + FIRST_PERSON_NOTE + subjectNote + correctionNote + styleDirective(style);
      const ctx = `Context: ${type}${label ? ` — ${label}` : ""}${date ? `, ${date}` : ""}${localTime ? ` (written ${localTime})` : ""}.`;
      const r = await callLLM(sys, `${ctx}\n\nText:\n\n${String(text).slice(0, 16000)}`, style ? 0.8 : 0.4, ["summary", "outline"], cfg);
      const s = (v) => (typeof v === "string" ? v.trim() : "");
      res.status(200).json({ summary: structureFull(s(r.summary)), outline: s(r.outline) });
      return;
    }

    // Spine batch: one call summarizes a changed LEAF and rolls it up its whole ancestor
    // chain (siblings supplied pre-summarized) — the cheap path for a single add/edit.
    if (mode === "spine") {
      const { leaf = {}, chain = [], style = "" } = body;
      const text = String(leaf.text || "").trim();
      if (!text) { res.status(400).json({ error: "No leaf text" }); return; }
      const subj = leaf.subject || "";
      const subjectNote = subj ? `\n\nSUBJECT — The leaf is about "${subj}"; use exactly that name and spelling, correcting any mis-transcription.` : "";
      const sys = SPINE_SYSTEM + subjectNote + styleDirective(style);
      const chainDesc = chain.map((n) => `key "${n.key}" — ${n.type} "${n.label}"; from ${JSON.stringify(n.from || [])}; others:\n${(n.others || []).map((p, i) => `    (${i + 1}) ${p}`).join("\n") || "    (none)"}`).join("\n\n");
      const user = `LEAF (${leaf.type || "memory"}${subj ? `, about "${subj}"` : ""}${leaf.label ? `, ${leaf.label}` : ""}):\n${text.slice(0, 8000)}\n\nCHAIN (summarize each node only after its children):\n${chainDesc.slice(0, 14000)}`;
      const r = await callLLM(sys, user, style ? 0.7 : 0.4, ["leaf", "nodes"], cfg);
      const s = (v) => (typeof v === "string" ? v.trim() : "");
      const norm = (o, isLeaf) => (o && typeof o === "object") ? {
        word: s(o.word), phrase: s(o.phrase), sentence: s(o.sentence), paragraph: s(o.paragraph),
        summary: structureFull(s(o.summary)), outline: s(o.outline),
        rewrite: isLeaf ? (s(o.rewrite) ? structureFull(s(o.rewrite)) : "") : "",
      } : null;
      const nodes = {};
      for (const [k, v] of Object.entries(r.nodes || {})) { const n = norm(v, false); if (n) nodes[k] = n; }
      res.status(200).json({ leaf: norm(r.leaf, true), nodes });
      return;
    }

    // day mode
    const { date = "", text = "", previousSummary = "", localTime = "", style = "", format = "prose", subject = "" } = body;
    if (!text.trim()) {
      res.status(400).json({ error: "No text provided" });
      return;
    }

    const when = `Entry date: ${date}${localTime ? `\nWritten at (local time): ${localTime}` : ""}`;
    const user = previousSummary
      ? `${when}\n\nThere is an existing summary for this day:\n${previousSummary}\n\nHere is a NEW entry to fold into it. Rewrite the full summary so it covers both, using the tense rules for the time it was written:\n\n${text.slice(0, 12000)}`
      : `${when}\n\nRaw journal text:\n\n${text.slice(0, 12000)}`;

    // The user-supplied subject is authoritative for its name/spelling (speech-to-text
    // often mangles it). It may be a person, a place, or a thing.
    const subjectNote = subject
      ? `\n\nSUBJECT — This is about "${subject}". Use exactly that name and spelling for it throughout, correcting any misspelling or mis-transcription of it in the source text. Do not invent a different name.`
      : "";
    // Prose is first person; the outline stays neutral (subjectless bullets).
    const sys = DAY_SYSTEM + (format === "outline" ? outlineDirective() : FIRST_PERSON_NOTE) + subjectNote + styleDirective(style);
    const result = await callLLM(sys, user, style ? 0.8 : 0.3, undefined, cfg);
    // Don't run prose paragraph-splitting on an outline — keep its bullets/newlines intact.
    const full = format === "outline" ? result.full : structureFull(result.full);
    res.status(200).json({ brief: result.brief, full });
  } catch (err) {
    res.status(500).json({ error: err.message || "Summarization failed" });
  }
}
