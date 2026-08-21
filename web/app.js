const journal = await fetch("./data/journal.json", { cache: "no-store" }).then((r) => r.json());

const state = {
  zoom: "week",
  focusDate: journal.meta.dateRange?.end ?? Object.keys(journal.days)[0],
};

const els = {
  root: document.getElementById("calendar-root"),
  periodLabel: document.getElementById("period-label"),
  periodBrief: document.getElementById("period-brief"),
  detailPanel: document.getElementById("detail-panel"),
  detailBackdrop: document.getElementById("detail-backdrop"),
  detailDate: document.getElementById("detail-date"),
  detailBrief: document.getElementById("detail-brief"),
  detailFull: document.getElementById("detail-full"),
  closeDetail: document.getElementById("close-detail"),
};


function parseDate(iso) {
  return new Date(iso + "T12:00:00");
}

function formatDate(iso, style = "long") {
  return parseDate(iso).toLocaleDateString("en-US", style === "long"
    ? { weekday: "long", month: "long", day: "numeric", year: "numeric" }
    : { month: "short", day: "numeric" });
}

function monthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function sundayWeekStart(iso) {
  const d = parseDate(iso);
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

function weekDates(iso) {
  const d = parseDate(iso);
  const day = d.getDay();
  const start = new Date(d);
  start.setDate(d.getDate() - day);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(start);
    x.setDate(start.getDate() + i);
    return x.toISOString().slice(0, 10);
  });
}

function dayExcerpt(day, maxChars = 160) {
  const first = day.full.split("\n\n").find(Boolean) ?? day.brief;
  if (first.length <= maxChars) return first;
  const cut = first.slice(0, maxChars);
  const end = cut.lastIndexOf(" ");
  return (end > 80 ? cut.slice(0, end) : cut).trim() + "…";
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function weeksWithEntriesInMonth(monthKey) {
  const byWeek = new Map();
  for (const iso of Object.keys(journal.days).filter((d) => d.startsWith(monthKey)).sort()) {
    const key = sundayWeekStart(iso);
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key).push(iso);
  }
  return [...byWeek.entries()]
    .map(([key, dates]) => ({ key, dates }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function weekLabel(dates) {
  const start = dates[0];
  const end = dates[dates.length - 1];
  if (start === end) return formatDate(start, "long");
  return `${formatDate(start, "short")} – ${formatDate(end, "short")}`;
}

function periodExcerpt(period, maxChars = 200) {
  const text = period?.full?.split("\n\n").find(Boolean) ?? period?.brief ?? "";
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const end = cut.lastIndexOf(" ");
  return (end > 80 ? cut.slice(0, end) : cut).trim() + "…";
}

function weekImage(dates) {
  for (const iso of dates) {
    const img = journal.days[iso]?.images?.[0];
    if (img) return img.url;
  }
  return null;
}

function monthImage(monthKey) {
  for (const iso of Object.keys(journal.days).filter((d) => d.startsWith(monthKey)).sort()) {
    const img = journal.days[iso]?.images?.[0];
    if (img) return img.url;
  }
  return null;
}

function getPeriodSummary(zoom, focusDate) {
  const year = focusDate.slice(0, 4);
  const month = focusDate.slice(0, 7);
  const week = sundayWeekStart(focusDate);

  if (zoom === "year") {
    return journal.periods[year] ?? { label: year, brief: "", full: "" };
  }
  if (zoom === "month") {
    const period = journal.periods[month];
    return period ?? { label: monthLabel(month), brief: "", full: "" };
  }
  if (zoom === "week") {
    const dates = weekDates(focusDate);
    return journal.periods[week] ?? {
      label: `Week of ${formatDate(dates[0])}`,
      brief: "",
      full: "",
    };
  }
  return null;
}

function openDetail(iso) {
  const day = journal.days[iso];
  if (!day) return;
  els.detailDate.textContent = `${day.dayOfWeek} · ${formatDate(iso)}`;
  els.detailBrief.textContent = day.brief;
  const imagesHtml = (day.images?.length)
    ? `<div class="detail-images">${day.images.map((img) =>
        `<figure><img src="${img.url}" alt="Journal photo" loading="lazy"></figure>`
      ).join("")}</div>`
    : "";
  els.detailFull.innerHTML = imagesHtml + day.full.split("\n\n").map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  els.detailPanel.hidden = false;
  els.detailBackdrop.hidden = false;
}

function closeDetail() {
  els.detailPanel.hidden = true;
  els.detailBackdrop.hidden = true;
}

function renderYear() {
  const year = state.focusDate.slice(0, 4);
  const period = getPeriodSummary("year", state.focusDate);
  els.periodLabel.textContent = period.label || year;
  els.periodBrief.textContent = period.brief ?? "";

  const months = Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, "0")}`;
    const entryCount = Object.keys(journal.days).filter((d) => d.startsWith(key)).length;
    const summary = journal.periods[key];
    return {
      key,
      entryCount,
      label: monthLabel(key),
      brief: summary?.brief ?? (entryCount ? "Tap to view weeks." : ""),
    };
  }).filter((m) => m.entryCount > 0);

  els.root.innerHTML = `<div class="year-grid">${months.map((m) => {
    const thumb = monthImage(m.key);
    const imgHtml = thumb ? `<img class="year-month-thumb" src="${thumb}" alt="">` : "";
    return `<article class="year-card" data-month="${m.key}">
      ${imgHtml}
      <div class="year-card-body">
        <p class="card-label">${m.entryCount} ${m.entryCount === 1 ? "entry" : "entries"}</p>
        <h3 class="card-title">${m.label}</h3>
        <p class="card-brief">${escapeHtml(m.brief)}</p>
      </div>
    </article>`;
  }).join("")}</div>`;

  els.root.querySelectorAll(".year-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.zoom = "month";
      const firstEntry = Object.keys(journal.days).find((d) => d.startsWith(card.dataset.month));
      state.focusDate = firstEntry ?? `${card.dataset.month}-01`;
      syncZoomButtons();
      render();
    });
  });
}

function renderMonth() {
  const period = getPeriodSummary("month", state.focusDate);
  const monthKey = state.focusDate.slice(0, 7);
  els.periodLabel.textContent = monthLabel(monthKey);
  els.periodBrief.textContent = period.brief ?? "";

  const weeks = weeksWithEntriesInMonth(monthKey);

  if (!weeks.length) {
    els.root.innerHTML = `<p class="nav-hint">No entries this month.</p>`;
    return;
  }

  els.root.innerHTML = `
    <div class="month-weeks-grid">
      ${weeks.map(({ key, dates }) => {
        const summary = journal.periods[key];
        const label = summary?.label ?? `Week of ${formatDate(dates[0])}`;
        const brief = summary?.brief ?? weekLabel(dates);
        const excerpt = periodExcerpt(summary);
        const thumb = weekImage(dates);
        const imgHtml = thumb
          ? `<img class="month-week-thumb" src="${thumb}" alt="">`
          : "";
        return `<article class="month-week-card" data-week-date="${key}">
          ${imgHtml}
          <div class="month-week-body">
            <p class="card-label">${dates.length} ${dates.length === 1 ? "entry" : "entries"} · ${weekLabel(dates)}</p>
            <h3 class="card-title">${escapeHtml(label)}</h3>
            <p class="card-brief">${escapeHtml(brief)}</p>
            ${excerpt && excerpt !== brief ? `<p class="month-week-excerpt">${escapeHtml(excerpt)}</p>` : ""}
          </div>
        </article>`;
      }).join("")}
    </div>
    <p class="nav-hint">Click a week to view days.</p>
  `;

  els.root.querySelectorAll(".month-week-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.zoom = "week";
      state.focusDate = card.dataset.weekDate;
      syncZoomButtons();
      render();
    });
  });
}

function renderWeek() {
  const period = getPeriodSummary("week", state.focusDate);
  els.periodLabel.textContent = period.label ?? "";
  els.periodBrief.textContent = period.brief ?? "";

  const entryDays = weekDates(state.focusDate)
    .filter((iso) => journal.days[iso]);

  if (!entryDays.length) {
    els.root.innerHTML = `<p class="nav-hint">No entries this week.</p>`;
    return;
  }

  els.root.innerHTML = `<div class="week-list">${entryDays.map((iso) => {
    const day = journal.days[iso];
    const label = formatDate(iso, "short");
    const excerpt = dayExcerpt(day);
    const thumb = day.images?.[0]
      ? `<img class="week-day-thumb" src="${day.images[0].url}" alt="">`
      : "";
    return `<article class="week-day has-entry" data-date="${iso}">
      <div class="week-day-header">
        <div>
          <p class="week-day-dow">${day.dayOfWeek}</p>
          <h3 class="week-day-date">${label}</h3>
        </div>
        ${thumb}
      </div>
      <p class="week-day-brief">${escapeHtml(day.brief)}</p>
      <p class="week-day-excerpt">${escapeHtml(excerpt)}</p>
    </article>`;
  }).join("")}</div>
  <p class="nav-hint">Click a day for the full summary.</p>`;

  els.root.querySelectorAll(".week-day.has-entry").forEach((card) => {
    card.addEventListener("click", () => openDetail(card.dataset.date));
  });
}

function syncZoomButtons() {
  document.querySelectorAll(".zoom-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.zoom === state.zoom);
  });
}

function render() {
  if (state.zoom === "year") renderYear();
  else if (state.zoom === "week") renderWeek();
  else renderMonth();
}

document.querySelectorAll(".zoom-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.zoom = btn.dataset.zoom;
    syncZoomButtons();
    render();
  });
});

els.closeDetail.addEventListener("click", closeDetail);
els.detailBackdrop.addEventListener("click", closeDetail);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

syncZoomButtons();
render();
