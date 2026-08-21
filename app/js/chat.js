// "Ask" view — chat with the journal. Sends the conversation + all entries to /api/chat.
// Conversation lives in memory for the session.

import { getAllEntries } from "./db.js";

function renderText(t) {
  const esc = String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return "<p>" + esc
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>") + "</p>";
}

function localTime() {
  return new Date().toLocaleString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function initChat(root) {
  root.innerHTML = `
    <div class="chat-log" id="chat-log">
      <p class="chat-hint">Ask about your days. Try “When did I mention the sprinklers?”,
      “Find every day I talked about Nat,” or “What patterns do you notice this week?”</p>
    </div>
    <form class="chat-form" id="chat-form">
      <textarea id="chat-input" rows="1" placeholder="Ask your journal…"></textarea>
      <button type="submit" class="chat-send" id="chat-send" aria-label="Send">Send</button>
    </form>
  `;

  const log = root.querySelector("#chat-log");
  const form = root.querySelector("#chat-form");
  const input = root.querySelector("#chat-input");
  const sendBtn = root.querySelector("#chat-send");

  const messages = []; // { role, content }

  function addBubble(role, html) {
    const div = document.createElement("div");
    div.className = `chat-msg ${role}`;
    div.innerHTML = html;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }
  input.addEventListener("input", autosize);

  async function send() {
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    autosize();
    messages.push({ role: "user", content: q });
    addBubble("user", renderText(q));

    const bubble = addBubble("assistant thinking", "<p>…</p>");
    sendBtn.disabled = true;
    try {
      const entries = (await getAllEntries()).map((e) => ({
        date: e.date, dayOfWeek: e.dayOfWeek, brief: e.brief, full: e.full,
      }));
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, entries, localTime: localTime() }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `Server error ${res.status}`);
      }
      const data = await res.json();
      messages.push({ role: "assistant", content: data.reply });
      bubble.className = "chat-msg assistant";
      bubble.innerHTML = renderText(data.reply);
    } catch (err) {
      bubble.className = "chat-msg assistant error";
      bubble.textContent = `Couldn't answer: ${err.message}`;
    } finally {
      sendBtn.disabled = false;
      log.scrollTop = log.scrollHeight;
    }
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  return { focus: () => input.focus() };
}
