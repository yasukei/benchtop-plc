import { expect, it } from "vitest";
import { callStandardFunction } from "./index.js";

it("keeps CONCAT's four-digit year limit separate from destination storage bounds", () => {
  for (const year of [0, 10000, "18446744073709551615"]) {
    expect(() => callStandardFunction("CONCAT_DATE", [year, 1, 1])).toThrow("Invalid date");
  }
  for (const year of [1, 9999]) {
    expect(() => callStandardFunction("CONCAT_DATE", [year, 1, 1])).toThrow(
      "Calendar value outside type range",
    );
  }
  expect(callStandardFunction("CONCAT_DATE", [1970, 1, 1])).toBe(0);
  expect(callStandardFunction("CONCAT_DATE", [2106, 2, 7])).toBe(4294944000);
  expect(() => callStandardFunction("CONCAT_DATE", [2106, 2, 8])).toThrow(
    "Calendar value outside type range",
  );
});
