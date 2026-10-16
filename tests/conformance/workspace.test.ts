import { packageName as compiler } from "@benchtop-plc/compiler";
import { packageName as runtime } from "@benchtop-plc/runtime";
import { describe, expect, it } from "vitest";

// Placeholder until the conformance harness lands; keeps workspace imports working here.
describe("conformance workspace", () => {
  it("can import the engine packages", () => {
    expect([compiler, runtime]).toEqual(["@benchtop-plc/compiler", "@benchtop-plc/runtime"]);
  });
});
