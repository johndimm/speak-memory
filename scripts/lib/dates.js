const MONTHS = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const DATE_PATTERNS = [
  /\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i,
  /\bit'?s\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/i,
  /\bokay\s+so\s+this\s+is\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?/i,
  /\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})(?:\s+it'?s\s+\w+day)?\b/i,
];

export function parseDateFromText(text, defaultYear = 2026) {
  for (const re of DATE_PATTERNS) {
    const match = text.match(re);
    if (!match) continue;
    const monthName = match[1].toLowerCase();
    const month = MONTHS[monthName];
    if (!month) continue;
    const day = parseInt(match[2], 10);
    if (day < 1 || day > 31) continue;
    const yearMatch = match[0].match(/\b(20\d{2})\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : defaultYear;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return null;
}

export function sundayWeekKey(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

export function isoWeekKey(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - day);
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

export function yearKey(dateStr) {
  return dateStr.slice(0, 4);
}
