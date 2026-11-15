export function today(): string {
  return toISODate(new Date());
}

export function toISODate(d: Date): string {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(iso: string, months: number): string {
  const d = new Date(iso + "T12:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
}

export function quarterOf(iso: string): { year: number; quarter: number } {
  const [y, m] = iso.split("-").map(Number);
  return { year: y, quarter: Math.floor((m - 1) / 3) + 1 };
}

export function quarterRange(year: number, quarter: number): { from: string; to: string } {
  const m1 = (quarter - 1) * 3 + 1;
  const from = `${year}-${String(m1).padStart(2, "0")}-01`;
  const to = toISODate(new Date(Date.UTC(year, m1 + 2, 0, 12)));
  return { from, to: to };
}

/** Deadline aangifte BTW/ICP/OSS: laatste dag van de maand na het kwartaal. */
export function quarterDeadline(year: number, quarter: number): string {
  const m = quarter * 3 + 1; // maand na kwartaal (1-based), kan 13 zijn
  const y = m > 12 ? year + 1 : year;
  const mm = m > 12 ? 1 : m;
  return toISODate(new Date(Date.UTC(y, mm, 0, 12)));
}

const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const MONTHS_LONG = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

export function fmtDate(iso: string | null | undefined, long = false): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return long ? `${d} ${MONTHS_LONG[m - 1]} ${y}` : `${d} ${MONTHS[m - 1]} ${y}`;
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "";
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export function monthLabel(i: number): string {
  return MONTHS[i];
}
