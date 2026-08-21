# Build prompt — replicate this app from scratch

Paste this into a fresh coding project to recreate *Speak, Memory*. It describes the product and the architecture; let the agent make reasonable local choices.

---

Build a **phone-first personal journaling web app** called **Speak, Memory**. Vanilla JavaScript ES modules, a static frontend, and one serverless function for the AI. No framework. Everything is stored **locally** in the browser (IndexedDB); the only network calls are to an LLM for summarization.

## Core idea
Every piece of writing is summarized into a **ladder** — one word → phrase → sentence → paragraph → complete summary → outline — and also kept **verbatim**. The same ladder is produced at every scale of time (day → week → month → year → decade → **life**) and for memory groupings (memory → subject → category). The reader zooms: distilled summaries lead; the long prose is opened only on demand.

## Data model — one thing
There is **one kind of record: an entry** — text anchored in time:
`{ id, text/raw, category, subject, year|date, month?, day?, endYear?, ongoing?, photos, levels, correction }`
- A **journal entry** is an entry with a full date and the default `category: "journal"`, `subject: "today"`.
- A **memory** is an entry with a real category + subject and a past year or range (or "ongoing").
- Store them in a single IndexedDB object store keyed by id (journal entries keyed by date, memories by a generated id). Keep a separate store for the derived period summaries (cache), and one for app periods.

## The summarizer — a dirty/ready graph
Model the whole thing as a **DAG of nodes**: leaves are entries; internal nodes are periods (week…life) and groupings (subject, category). Memories have **two parents** — their decade (by date) and their subject/category.
- A node is **dirty** if it needs (re)summarizing. A leaf is dirty when it has raw text but no summary. A period is dirty when a stored content-hash of its children no longer matches — so re-summarizing a child automatically dirties its parents.
- A node is **ready** when all its children are clean.
- A background loop repeatedly takes every **dirty-and-ready** node and summarizes it, **in parallel** under a small concurrency limit, until nothing dirty is ready. This gives leaves-first ordering for free, and adding one entry only dirties a single spine up to Life.
- Never summarize a parent over an unsummarized child; if a child's call fails, defer the parent and retry on backoff.

## Fast leaves, lazy prose
The leaf summarization call must be **fast**: request only the distilled rungs (word/phrase/sentence/paragraph). Generate the **complete summary** and **outline** lazily — only when the reader opens them — via a separate call, and cache them on the record. Roll-ups summarize their children's short summaries, stepping down (summary → paragraph → sentence → word) if the combined input is too large.

## UI — four tabs
- **Write**: text + dictation (Web Speech API) + photos; a collapsible "A past memory?" section revealing category (chips), subject (chips filtered by category), and a year / end-year / "still going" control. One form; a filled category makes it a memory. Editing an existing day or memory opens it here, prefilled.
- **Journal**: one **generic page component** used for every level — breadcrumb → name → word → phrase → sentence (with a "Complete summary" toggle that *replaces* the sentence in place) → list of child cards (one-line links) → outline → verbatim (leaves only). Memories also render a **timeline** (a bar per memory across its years, label beside the bar) on category/subject pages. No breadcrumb at the root.
- **Graph**: a live SVG of the node graph, laid out in rows by level. Clean nodes quiet, dirty nodes glow, the active one pulses. Pan/zoom/pinch, full-screen, tap-a-node preview (name + sentence + "Open ›" into the Journal). Stagger crowded labels; collapse very crowded rows into a count bubble (and don't draw edges into bubbles).
- **Settings**: landing level; a **Voice** selector (author styles applied to generated prose); Export / Import / Delete-everything (both entries and memories); and this guide.

## The LLM function
One serverless endpoint (OpenAI-compatible chat completions, `response_format: json_object`) with modes:
- `levels` (distilled rungs; or full ladder for roll-ups),
- `detail` (complete summary + outline, generated lazily),
- period/roll-up summarization.
Support a **voice/style** directive, a **first-person** directive for prose, a **subject** directive that fixes a name's spelling, and a **correction** directive: when the reader flags a summary as wrong, feed their note into every future summarization of that record.

## Feel
Warm, paper-like, phone-first; serif display type; instant capture (saving never blocks on the model); progress shown as a small toast that climbs the levels; honest about being AI-assisted (verbatim words are always kept and shown).

Build it in stages, keep it working at each step, and don't create entities beyond necessity.
