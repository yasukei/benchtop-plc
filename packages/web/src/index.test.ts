import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@benchtop-plc/web", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@benchtop-plc/web");
  });
});
