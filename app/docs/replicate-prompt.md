# Build prompt — replicate this app from scratch

Paste this into a fresh coding project to recreate *Speak, Memory*. It describes the product and the architecture; let the agent make reasonable local choices.

---

Build a **phone-first personal journal you talk to**, called **Speak, Memory**. Use vanilla JavaScript ES modules, a static frontend and a couple of serverless functions for the AI. No framework. Everything is stored **locally** in the browser (IndexedDB); the only network calls go to an LLM.

## Core idea
Every piece of writing is summarized into a **ladder**: one word → phrase → sentence → paragraph → complete summary → outline, while the transcript is also kept. The same ladder exists at every scale of time (day → week → month → year → decade → **Life**) and for story groupings (story → subject → category). Summaries must be **faithful**: compress and reword, never add details that weren't said. They're written in the first person, in a chosen voice.

## Past · present · future, and who's who
- **Journal** (the present): today, in your own words.
- **Stories** (the past): memories with a category, an optional subject and years.
- **Futures**: imagined raw diary days from tomorrow onward, as a read-only journal of their own.
- **Me**: you, and your life *now*.
- **Names**: everyone and everything mentioned.

Use settles into **four levels**, and a small **Next** button nudges new users through them: (1) just the Journal; (2) Me and Names; (3) Stories; (4) a Future.

## Data model
- **One `items` store** holding journal entries (keyed by date), stories (generated id) and **entities** (names, with canonical name, kind person/animal/place/org/thing, aliases, your note, profile, facts). Plus a **`periods`** store: the cached roll-up summaries, keyed like `W2026-09-20`, `M2026-09`, `Y2026`, `D2020`, `LIFE`, `CAT:Homes`, `SUB:Homes\0Elm St`.
- Every leaf keeps its transcript. Only the 40 most recent keep it word for word; older leaves keep the full summary and a faithful retelling.
- **Me** is a special entity whose facts hold the current state: home, who you live with, work, hobbies (each with a *since* year), birth year, family, best friends.
- Summaries carry **name tokens** `{{e:id|Name}}`, rendered as links to each name's page.

## The summarizer: a dirty/ready graph
Model everything as a **DAG**: leaves are days and stories; internal nodes are periods and groupings. A story has two parents: its decade and its subject/category.
- A leaf is **dirty** until it has a complete summary. A period is dirty when a hash of its children's short summaries (plus the prompt version and voice) no longer matches the stored one.
- A node is **ready** when all its children are clean. A background loop summarizes every dirty-and-ready node, in parallel (about four at a time), until none are left. A single-child node is copied up instead of summarized again.
- Name-finding rides along with leaf summarization and resolves names on the client by normalized name and alias, so no roster is ever sent to the model. Skip products, software, shows, codes and famous people mentioned in passing.
- The client waits longer than the server's own time budget, and the server retries only malformed JSON, so the app never competes with itself.

## Input: one layout everywhere
Journal, Stories, Me and each Name page share **one design**:
- **Layout:** breadcrumb, then the text box (in edit) or **✎ Edit** (in reading), then the title, the content, **Save / Cancel**, and **Delete** at the bottom.
- **Modes:** an empty page opens ready to write; a page with content opens for reading.
- **Drafts** are kept in localStorage as you type. Save shows the result at once and does the slow work (facts, names, profile) in the background, never pulling the user back to a page they've left.
- **Found** chips show the names spotted as you type, with an icon per kind; tap one to open it.
- **Dictation** uses the Web Speech API.

## Pages
- **Browse:** the life tree, Life → decades → years → months → weeks → days, plus stories by category → subject. Every node shows the word, phrase and sentence, then the full summary with a Summary | Outline switch and its children. A day or story shows word, phrase, Summary | Outline, and a closed **Transcript** fold.
- **Me:** you just talk. One question at a time rolls above the box ("Where do you live, and since when?"), and the answers tick off as chips. Relative times ("for ten years") become years. A **bucket list** lives here.
- **Names:** a list with dashed cards for names that still need a word from you (0–1 mentions). Names mentioned twice or more are described automatically from the journal. A Name page has a profile, facts, every mention, and "Ask about…". Also: Select for batch delete, and a rename that fixes the spelling everywhere.
- **Stories:** each thread (Homes, Relationships, Jobs, Hobbies, plus any other category) is a horizontal timeline: `[＋ before] [story] [story] … [NOW from Me]`. Tapping ＋ asks the question ("Where did you live before Elm St? When?").
- **Futures:** one list to switch between **Now · Your journal** and each Future, then a folded **＋ New future**: an optional prompt, 10 years / 20 years / to age 95, the number of days, and "Do my bucket list".
- **More:** Me, a Timeline (life as parallel lanes), a Map of places, Activity (the live job queue plus the graph), and the Guide.

## Futures
- A Future stores **only its imagined years**. Inside it, every read also pulls the real journal live, marked read-only, and merges it in; nothing from the past is ever copied or changed.
- Pure-past summaries are reused, and only levels spanning past and future are summarized again.
- A Future always starts **tomorrow**. It's grounded in the journal's day summaries, the stories, Me's facts, the Life and decade summaries, one sentence per name (kept exactly as described), the bucket list, and the prompt.
- Inside a Future the tab bar is unchanged, with the writing tabs grayed out. A banner shows the span and the prompt.

## The LLM functions
An OpenAI-compatible chat endpoint (`response_format: json_object`) with modes for:
- `levels`: a leaf's or roll-up's full ladder, plus the names in it;
- name finding;
- a name's profile and facts;
- **onboard**: pulling Me's facts, with since-years, out of free talk;
- the **future** generator.

Support a voice/style directive, a subject directive that fixes a name's spelling, and a correction directive.

## Feel
Two looks: **Classic** (warm paper, a serif display face, an orange accent) and **Modern** (white, Inter for the interface, a text serif for reading, an indigo accent). The header is always two rows: title, then tabs. Capture never blocks on the model. Summaries arrive in the background and can be watched in Activity. The app is honest about being AI-assisted: your words are always one tap away.

Build it in stages, keep it working at each step, and don't create entities beyond necessity.
