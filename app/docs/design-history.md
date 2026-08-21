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

## Principles that kept showing up
- **Capture never blocks on the model** — save is instant; summaries fill in behind you.
- **Distilled first; prose on demand** — the ladder leads, the long text waits to be asked for.
- **Verbatim is the source of truth** — the AI's summaries sit on top of your exact words.
- **Don't create entities beyond necessity** — every time two concepts turned out to be one, we merged them.
