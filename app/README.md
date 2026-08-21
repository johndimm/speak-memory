# As The World Turns — phone app

A phone-first journal. Open it as a web page, type (or dictate with your
keyboard's mic) into a text box, add a photo, and it saves an LLM summary.
No Google Doc, no notebook required.

## How it works

- **Write** view: a plain text box + photo picker. Tap the mic on your phone
  keyboard to dictate. On save it calls `/api/summarize`, stores the summary +
  photos, and **throws the raw text away**.
- **Journal** view: the year / month / week zoom calendar. Period summaries are
  generated on demand with the *Summarize* button.
- **Storage**: everything lives in **IndexedDB in your browser, on this device**.
  Nothing is uploaded except the text you send to the summarizer. Your journal
  is on the phone you write it on (cross-device sync is a later, server step).
- **The key**: `DEEPSEEK_API_KEY` lives only in the Vercel function's
  environment, never in the browser.

## Deploy to Vercel

```bash
cd app
npm i -g vercel          # or use: npx vercel

vercel                   # first run: link/create the project
vercel env add DEEPSEEK_API_KEY   # paste your key (Production + Preview)
# optional: vercel env add DEEPSEEK_MODEL   # defaults to deepseek-chat

vercel --prod            # deploy; open the printed URL on your phone
```

If you deploy the whole repo instead of just this folder, set the project's
**Root Directory** to `app` in Vercel → Settings → General.

## Run locally

```bash
cd app
cp .env.example .env.local   # add your DEEPSEEK_API_KEY
vercel dev                   # serves the app + /api on http://localhost:3000
```

(A plain static server like `npx serve` won't work — the summarize endpoint
needs the Vercel function runtime.)

## Files

```
app/
  api/summarize.js   serverless function (holds the key, calls DeepSeek)
  index.html         two views: Write and Journal
  styles.css
  js/
    db.js            IndexedDB wrapper (entries + cached period summaries)
    record.js        Write view — text box + photos → summarize → store
    calendar.js      Journal view — zoom calendar from IndexedDB
    main.js          view routing
```
