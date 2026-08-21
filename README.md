# Summarizing Journal

Turn stream-of-consciousness Google Doc entries into a zoomable life calendar — raw speech in, compact summaries out.

## Quick start

```bash
cp .env.example .env.local      # add your DEEPSEEK_API_KEY
npm run refresh               # fetch → parse → images → summarize → build
npm run dev                   # http://localhost:3456
```

## Commands

| Command | What it does |
|---------|--------------|
| `npm run fetch` | Download text + HTML from Google Doc |
| `npm run parse` | Split raw text into dated segments |
| `npm run images` | Extract embedded photos → `web/data/images/` |
| `npm run summarize` | LLM summaries (cached; skips unchanged days) |
| `npm run build` | Full local rebuild without re-fetching |
| `npm run refresh` | Complete pipeline: fetch through build |
| `npm run watch` | Poll doc every 30 min; refresh on change |
| `npm run dev` | Serve calendar UI |

## Weekly Google Docs

Journal entries are split across **one Google Doc per week** (new doc each Sunday). Config: `data/docs.json`.

| Week | Status | Doc |
|------|--------|-----|
| Jul 5–11, 2026 | archived | `1vzLSGbK-...` (your first 3 days) |
| Jul 12+, 2026 | **active** | create a new doc (see below) |

### Start a new week (Sundays)

```bash
npm run new-week          # archive last week, open a new slot
# Create new Google Doc, share as "anyone with link can view"
npm run set-doc -- DOC_ID # paste ID from the URL
npm run refresh
```

### Where things are cached

| What | Location | Scales? |
|------|----------|---------|
| LLM day + period summaries | `data/summaries-cache.json` | Yes — only changed days re-summarize |
| Per-week raw exports | `data/raw/YYYY-MM-DD.txt` | Yes — one small file per week |
| Images (deduped by hash) | `web/data/images/` + `data/images.json` | Yes — each photo stored once |
| Calendar UI data | `data/journal.json` | Yes — compact summaries only |

`npm run refresh` fetches **all** archived docs plus the active doc, merges them, and rebuilds the calendar.

## Auto-summarization

Summaries are generated via **DeepSeek**. Add your key to `.env.local`:

```
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-chat
```

Results are cached in `data/summaries-cache.json` keyed by content hash — only new or changed entries are re-summarized. Day, week, month, and year summaries are all generated automatically.

Without an API key, the build uses whatever is already in the cache (seed summaries are included for the initial 3 days).

## Scheduled refresh

**Watch mode** (good while working on the journal):

```bash
npm run watch
```

Polls the Google Doc every 30 minutes (configurable via `REFRESH_INTERVAL_MINUTES` in `.env`). Runs a full refresh when the doc changes.

**Cron** (runs even when you're not at the computer):

```bash
chmod +x scripts/cron-refresh.sh

# Edit crontab:
crontab -e

# Refresh every hour:
0 * * * * /Users/johndimm/projects/summerizing-journal/scripts/cron-refresh.sh >> /tmp/journal-refresh.log 2>&1
```

## Images

Photos embedded in the Google Doc are extracted from the HTML export and saved to `web/data/images/`. Each image is assigned to the nearest preceding date marker in the document. Images appear as thumbnails in the month view and in the day detail panel.

## Dates in Google Docs

| Source | Used? |
|--------|-------|
| Spoken/written dates in text ("Wed July 8 2026") | Yes — primary |
| Google Docs revision history | Not yet — requires Docs API + OAuth |

## Project structure

```
journal-raw.txt              # combined text (all weeks)
data/
  docs.json                  # weekly doc manifest
  raw/                       # per-week .txt + .html exports
  parsed.json                # dated segments
  summaries-cache.json       # LLM cache
  images.json                # image → date mapping
  journal.json               # final data for UI
web/
  data/journal.json          # copy served to browser
  data/images/               # extracted photos
scripts/
  fetch.js, parse.js, extract-images.js
  summarize.js, build-summaries.js
  refresh.js, watch.js
```

## Doc link

[The Days of our lives](https://docs.google.com/document/d/1vzLSGbK-Qh2nE1Fn5YnjNY9IEiQE_iabSqDTNxk-zPU/edit?usp=sharing)
