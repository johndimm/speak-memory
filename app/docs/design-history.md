# A history of the design

How *Speak, Memory* got to where it is — the major turns, and why each one happened.

## 1. A day journal with a summary
It started small: capture a day (typed or dictated), send it to an LLM, store a **prose** summary and an **outline** alongside the raw text and photos. Days rolled up into weeks, months, years — a calendar you could zoom.

## 2. Memories arrive
Days are dated and precise; a lot of a life isn't. So **memories** were added — vaguer, range-based recollections filed by **category** and **subject** ("girlfriends → Deena," 1980–1983). They lived in their own store and rolled up decade → life, with category pages for browsing.

## 3. Summarization *everywhere*
The pivotal idea (`prompt-summarization-everywhere.txt`): long prose sections drove people away. Every page should lead with **distillation** and reserve prose for the curious. So every node — day, decade, category, life — got the same **ladder**: word → phrase → sentence → paragraph → complete summary → outline, all requested in one call, and one **generic page template** rendered them all. This is the app's spine.

## 4. The summarizer becomes a graph, not a script
The first roll-up code was hand-written per level and ran as one long serial chain — slow, and easy to get out of order. It was replaced by a **dirty/ready dependency graph**: nodes are dirty when they need work and ready when their children are clean; a loop summarizes whatever is dirty-and-ready, **in parallel**, until nothing's left. Correctness (never summarize over an unsummarized child) and incremental updates (one new entry dirties a single spine to Life) fell out of the model instead of being coded by hand.

We briefly tried summarizing a whole ancestor chain in **one** LLM call — it timed out and returned invalid JSON. Reliable per-node calls, run concurrently, won.

## 5. Fast leaves, lazy prose
A "leaf" summary was secretly the biggest call in the system — it asked for a full-length "rewrite that condenses nothing," plus a multi-paragraph summary and outline, most of which was never shown. We **dropped the rewrite**, made leaves generate only the distilled rungs (seconds, not minutes), and moved the **complete summary and outline to lazy generation** — written only when a reader opens them. The visible ladder (word/phrase/sentence) lands almost instantly.

## 6. One store, one kind of thing
Journal entries and memories were maintained as two stores — but they're the **same object**: text anchored in time, differing only in date precision and whether they carry a category/subject. Storage was unified into a single `items` store (with a non-destructive migration), and the day-vs-memory distinction became a property of the data, not a separate type.

## 7. One form: Write
With the data unified, the two input screens (Today, Before) merged into a single **Write** tab. The default is a journal entry for today; open "A past memory?" and fill in a category to make it a memory. The Chat tab — which never earned its keep — was removed. In its place: a way to tell a summary *why* it's wrong, which re-summarizes and **remembers the correction**.

## 8. The Graph
To make the whole structure legible (and a little alive), the node graph got a **visual**: Life at the top, leaves at the bottom, dirty nodes glowing and the active one pulsing as summarization climbs. It gained pan/zoom, full-screen, and **tap-a-node previews** with an "Open ›" link into the Journal.

## 9. Names become a cast
Summaries started carrying **name tokens** (`{{e:id|Name}}`), rendered as links. Name-finding rides along with summarization and resolves names by normalized match and aliases, so no growing roster is ever sent to the model. Each name got a page: a profile, every mention in time order, and "Ask about…". Names mentioned twice or more get their description written from the journal; only the rest wait for you. Descriptions never guess a relationship or gender that isn't stated. A misspelling can be fixed **everywhere** by renaming it: every entry, story and summary level is rewritten in place.

## 10. Past · present · future
The app grew into three linked worlds: **Stories** (the past), the **Journal** (the present) and **Futures** (imagined years). **Me** and **Names** tell it who's who. Use settled into **four levels**: just the Journal; then Me and Names; then Stories; then a Future, where all of it pays off. A small **Next** button walks new users through them, and a Browse tab reads everything as one tree.

## 11. One way to enter anything
The four input pages (Journal, Stories, Me, a Name) each had grown their own buttons and modes, which confused people. They were redesigned to **one layout**: breadcrumb, then the text box (in edit) or ✎ Edit (in reading), then the title, the content, Save/Cancel and Delete. Empty pages open ready to write; pages with content open for reading. Drafts are kept as you type, and Save never pulls you back to a page you've left. Reading a day or story is also uniform: word, phrase, then Summary | Outline, with the transcript one tap away.

## 12. Talking fills the form
The long-standing goal, "freely fill out a form using voice", arrived in **Me**: you just talk, and one question at a time rolls above the box while the answers (home, who with, work, fun, each with *since when*, and your birth year) tick off as chips. **Stories** builds on that: each thread (Homes, Relationships, Jobs, Hobbies…) is a visual timeline ending in **Now** from Me, with a ＋ block just before Now that asks about the gap ("What came between Agate St and San Diego?").

## 13. Futures read the past; they don't copy it
Futures first seeded their own database with a *copy* of the past, which went stale and grew with every Future. Now a Future stores **only its imagined years** and reads your real journal **live and read-only**, merging it in. Pure-past summaries are reused, and only the levels that span past and future are summarized again. A Future starts **tomorrow**, and it's grounded in your whole arc (Life and decade summaries), Me, one sentence per name, and your bucket list, so a "rest of life" future can run from fifteen to ninety-five in your own voice.

## 14. Faster leaves, reversed
Section 5's lazy prose was eventually walked back. Leaves get their complete summary in the background pass, so a day is fully readable the moment you open it. The call stays quick because roll-ups summarize *summaries*, never raw text.

## Principles that kept showing up
- **Capture never blocks on the model** — save is instant; summaries fill in behind you.
- **Distilled first; prose on demand** — the ladder leads, the long text waits to be asked for.
- **Verbatim is the source of truth** — the AI's summaries sit on top of your exact words.
- **Don't create entities beyond necessity** — every time two concepts turned out to be one, we merged them.
- **One way to do a thing** — the same layout, labels and modes on every input page, so nothing has to be relearned.
- **Faithful over fluent** — summaries may compress, never invent; a guessed relationship is worse than none.
