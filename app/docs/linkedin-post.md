# LinkedIn post

**I built a journaling app around one idea: summarize *everything*, at every scale, and let the reader zoom.**

Most journaling apps store what you write and hand it back as a wall of text. *Speak, Memory* does the opposite. You dictate a few sentences; it compresses them **upward** into ever-shorter forms — a paragraph, a sentence, a phrase, and finally a single word — and it does the same for every week, month, year, decade, category, and for your whole life. Reading, you go the other way: start from the word and zoom down only where you're curious.

The provocative rung is at the top of the ladder: a whole life distilled to one sentence, one word. The word is a wink — no word holds a life. But a single *sentence* for a life can land on something essential. That's the bet.

A few design decisions I'm happy with:

**Everything is one kind of thing.** A "journal entry" and a "memory" turned out to be the same object — text anchored in time — differing only in date precision and whether it's filed under a category/subject. Collapsing that distinction removed a whole class of special-casing.

**The summarizer is a dependency graph, not a script.** Each node is *dirty* (needs summarizing) or *clean*; a parent is *ready* only when its children are clean. A small loop repeatedly summarizes whatever is dirty-and-ready, in parallel, until nothing's left. Add one entry and the "dirty" flag climbs a single spine — day → week → month → year → decade → life — instead of rebuilding the tree.

**Distilled first, heavy prose on demand.** The short rungs (word/phrase/sentence) are generated instantly; the long-form summary and outline are written lazily, only when a reader opens them. Leaf summarization went from minutes to seconds.

**It's honest about being AI-assisted.** If a summary is wrong, you say *why*, it re-summarizes with your correction, and it remembers the note for next time. Your verbatim words are always the source of truth.

It's a phone-first PWA, runs entirely in the browser with local storage, and uses an LLM only for the summaries. There's even a live graph view where you can watch the summarization climb from a new entry up to "a life."

Built with a lot of iteration and a coding agent as a pair. Happy to talk architecture with anyone building AI features that have to stay fast and trustworthy.

#AI #ProductDesign #LLM #SoftwareEngineering #PWA
