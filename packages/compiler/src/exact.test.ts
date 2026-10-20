import { expect, it } from "vitest";
import { exactNumber } from "./exact.js";

it.each(["1e99999999", "1e-99999999"])(
  "rejects %s before constructing its enormous decimal power",
  (source) => {
    expect(() => exactNumber(source)).toThrow("Constant decimal scale exceeds evaluation budget");
  },
);
