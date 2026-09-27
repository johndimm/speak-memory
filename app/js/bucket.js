// The bucket list — things you want to do while there's time. Lives on Me (your life now, and what you
// still hope for); a Future can be asked to do them all. Always YOUR list (your own journal's key, even
// from inside a Future), on this device.
import { jkey } from "./journal.js";
import { escapeHtml } from "./render.js";

export function getBucket() {
  try { return JSON.parse(localStorage.getItem(jkey("bucket-list", "")) || "[]").filter((x) => typeof x === "string"); }
  catch { return []; }
}
function setBucket(items) { try { localStorage.setItem(jkey("bucket-list", ""), JSON.stringify(items)); } catch { /* */ } }

// The section: a heading, the list (× to remove), and an Add box. Changes save at once.
export function bucketSectionHtml() {
  const items = getBucket();
  const rows = items.map((it, i) => `<li class="bucket-item"><span>${escapeHtml(it)}</span><button type="button" class="bucket-del" data-bucket-del="${i}" aria-label="Remove">×</button></li>`).join("");
  return `<section class="bucket-section" id="bucket-section">
      <h3 class="ent-kind">Bucket list</h3>
      <ul class="bucket-list">${rows || `<li class="bucket-empty">What do you want to do while there's time?</li>`}</ul>
      <form class="bucket-add" id="bucket-add-form">
        <input type="text" id="bucket-input" autocomplete="off" placeholder="e.g. see the northern lights, learn piano…">
        <button type="submit" class="bucket-addbtn">Add</button>
      </form>
    </section>`;
}

// Wire the section inside `root`; it redraws itself in place after each change.
export function wireBucketSection(root) {
  const sec = root.querySelector("#bucket-section");
  if (!sec) return;
  const redraw = () => { sec.outerHTML = bucketSectionHtml(); wireBucketSection(root); };
  sec.querySelector("#bucket-add-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = sec.querySelector("#bucket-input");
    const v = (input && input.value || "").trim();
    if (!v) return;
    setBucket([...getBucket(), v]);
    redraw();
    root.querySelector("#bucket-input")?.focus(); // keep adding
  });
  sec.querySelectorAll("[data-bucket-del]").forEach((b) => b.addEventListener("click", () => {
    const items = getBucket(); items.splice(Number(b.dataset.bucketDel), 1); setBucket(items); redraw();
  }));
}
