# Speak, Memory

A phone-first journal you **talk to**. Say anything about your day; it summarizes every entry
into a ladder (word → phrase → sentence → paragraph → summary → outline), and does the same for
every week, month, year, decade and your whole **Life**. Around the Journal: **Me** (your life
now), **Names** (who's who), **Stories** (your past, thread by thread) and **Futures**
(imagined years from tomorrow, built from all of it).

Everything lives in **IndexedDB in your browser**. Only the text being summarized is sent to the
LLM, and API keys stay in the serverless functions' environment. See `docs/users-guide.md` (also
in-app under More → Guide) for how it works for users.

## Run locally

```bash
cp app/.env.example app/.env.local      # add your keys (below)
node --watch app/dev-server.mjs         # http://localhost:3000, restarts on any file change
```

The small dev server serves the static app and runs the `/api` functions directly (it replaces
`vercel dev`, which fails on Node 25).

## Deploy (Vercel)

```bash
vercel env add DEEPSEEK_API_KEY         # once per key, Production + Preview
vercel --prod                           # from the repo root; the project's Root Directory is app/
```

### Environment

| Key | Used for |
|---|---|
| `DEEPSEEK_API_KEY` (required) | all summarizing, names, Me, Futures (`api/summarize.js`, `api/future.js`, `api/chat.js`) |
| `DEEPSEEK_MODEL` | override the default model |
| `OPENAI_API_KEY` | voices for the interviews and a Future's audio reveal (`api/tts.js`) |
| `GOOGLE_MAPS_API_KEY`, `GOOGLE_PLACES_API_KEY`, `GOOGLE_STREET_VIEW_STATIC_API_KEY` | Map images (`api/streetview.js`) |

Users can also bring their own model and key in ⚙ Settings.

## Files

```
app/
  index.html            tabs: Journal · Browse · Names · Stories · Futures · More ▾ · ⚙
  styles.css            Classic look + the Modern look (html.theme-modern)
  dev-server.mjs        local server
  api/
    summarize.js        the ladder (levels), names, Me (onboard), profiles/facts, …
    future.js           imagined diary days for a Future
    chat.js, tts.js, streetview.js
  js/
    main.js             tabs, routing, the guided Next button, the Future banner
    db.js               IndexedDB (items + periods); in a Future, a live read-only overlay of the real journal
    journal.js          multiple journals (yours, Futures, sample lives)
    record.js           Journal + Stories input pages; the Stories timelines
    entities.js         Me + Names pages; background describing; rename-everywhere
    calendar.js         Browse (the life tree) and the dirty/ready summarizing pass
    capture.js          live Found chips while you type
    futures.js          the Futures switcher and generation
    bucket.js, self.js, entityresolve.js, render.js, settings.js, activity.js, graph.js,
    timeline.js, places.js, dictation.js, voicetts.js, audioshow.js, …
  docs/                 User's Guide, About & privacy, demo, design history, diary, build prompt
```
