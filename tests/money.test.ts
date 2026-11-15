import { describe, it, expect } from "vitest";
import { parseEur, vatOf, splitGross, formatEur } from "@/lib/money";
import { quarterRange, quarterDeadline, addMonths } from "@/lib/dates";

describe("money", () => {
  it("parset Nederlandse en Engelse notatie", () => {
    expect(parseEur("1.234,56")).toBe(123456);
    expect(parseEur("1234.56")).toBe(123456);
    expect(parseEur("€ 12,5")).toBe(1250);
    expect(parseEur("-3,00")).toBe(-300);
    expect(parseEur("1.000")).toBe(100); // één punt = decimaal
    expect(parseEur("1.000.000")).toBe(100000000);
    expect(parseEur("abc")).toBeNull();
  });
  it("rekent BTW half-up", () => {
    expect(vatOf(1000, 2100)).toBe(210);
    expect(vatOf(5, 2100)).toBe(1); // 1,05 → 1
    expect(vatOf(-1000, 2100)).toBe(-210);
  });
  it("splitst incl. BTW", () => {
    expect(splitGross(12100, 2100)).toEqual({ base: 10000, vat: 2100 });
    expect(splitGross(5988, 2100)).toEqual({ base: 4949, vat: 1039 });
  });
  it("formatteert", () => {
    expect(formatEur(123456)).toBe("€ 1.234,56");
    expect(formatEur(-500)).toBe("−€ 5,00");
  });
});

describe("dates", () => {
  it("kwartalen en deadlines", () => {
    expect(quarterRange(2026, 3)).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(quarterDeadline(2026, 3)).toBe("2026-10-31");
    expect(quarterDeadline(2026, 4)).toBe("2027-01-31");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });
});

import { withParam } from "@/lib/action";
describe("withParam", () => {
  it("behoudt de hash", () => {
    expect(withParam("/a?x=1#top", "ok", "Klaar")).toBe("/a?x=1&ok=Klaar#top");
    expect(withParam("/a?error=oud", "ok", "x")).toBe("/a?ok=x");
  });
});
