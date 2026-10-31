import { describe, expect, it } from "vitest";
import { calendarDateNs, parseCalendar } from "./index.js";

describe("Gregorian date component validation", () => {
  it.each([
    [1, 1, 1, -62135596800000000000n],
    [99, 12, 31, -59011545600000000000n],
    [1970, 1, 1, 0n],
    [2000, 2, 29, 951782400000000000n],
    [9999, 12, 31, 253402214400000000000n],
    [10000, 1, 1, 253402300800000000000n],
  ] as const)("accepts %s-%s-%s without a caller year cap", (year, month, day, ns) => {
    expect(calendarDateNs(year, month, day)).toBe(ns);
  });

  it.each([
    [0, 1, 1],
    [-1, 1, 1],
    [2024, 0, 1],
    [2024, 13, 1],
    [2024, 1, 0],
    [2024, 1, 32],
    [2023, 2, 29],
    [1900, 2, 29],
    [2024, 4, 31],
    [2024.5, 1, 1],
    [2024, 1.5, 1],
    [2024, 1, 1.5],
    [Infinity, 1, 1],
    [NaN, 1, 1],
    [275761, 1, 1],
  ])("rejects impossible components %s-%s-%s", (year, month, day) => {
    expect(() => calendarDateNs(year, month, day)).toThrow("Invalid date");
  });

  it("supports the CONCAT caller's four-digit cap", () => {
    expect(calendarDateNs(1, 1, 1, 9999)).toBe(-62135596800000000000n);
    expect(calendarDateNs(9999, 12, 31, 9999)).toBe(253402214400000000000n);
    expect(() => calendarDateNs(10000, 1, 1, 9999)).toThrow("Invalid date");
  });

  it("leaves literal storage bounds separate from valid date components", () => {
    expect(() => parseCalendar("LDATE", "LD#0-01-01")).toThrow("Invalid date");
    for (const year of [1, 9999, 10000]) {
      expect(() => parseCalendar("LDATE", `LD#${year}-01-01`)).toThrow(
        "Calendar value outside type range",
      );
    }
    expect(parseCalendar("DATE", "D#1970-01-01")).toBe(0);
    expect(parseCalendar("DATE", "D#2106-02-07")).toBe(4294944000);
    expect(() => parseCalendar("DATE", "D#2106-02-08")).toThrow(
      "Calendar value outside type range",
    );
    expect(parseCalendar("LDATE", "LD#1677-09-22")).toBe("-9223286400000000000");
    expect(parseCalendar("LDATE", "LD#2262-04-11")).toBe("9223286400000000000");
  });
});
