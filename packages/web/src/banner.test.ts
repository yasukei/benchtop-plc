import type { Diagnostic } from "@benchtop-plc/core";
import { describe, expect, it } from "vitest";
import { bannerFor, type Banner } from "./banner.js";
import type { AppState } from "./store.js";

const fault: Diagnostic = { code: "runtime.division-by-zero", severity: "error", args: {} };
type BannerState = Pick<AppState, "connection" | "runtimeState" | "diagnostic">;

describe("banner selection", () => {
  const cases: [string, BannerState, Banner][] = [
    [
      "STOP without a diagnostic",
      { connection: "connected", runtimeState: "STOP", diagnostic: null },
      { key: "info", urgent: false },
    ],
    [
      "RUN without a diagnostic",
      { connection: "connected", runtimeState: "RUN", diagnostic: null },
      { key: "running", urgent: false },
    ],
    [
      "FAULT before its diagnostic arrives",
      { connection: "connected", runtimeState: "FAULT", diagnostic: null },
      { key: "fault", urgent: true },
    ],
    [
      "FAULT with a diagnostic",
      { connection: "connected", runtimeState: "FAULT", diagnostic: fault },
      { key: "fault", urgent: true },
    ],
    [
      "a latched diagnostic after STOP",
      { connection: "connected", runtimeState: "STOP", diagnostic: fault },
      { key: "fault", urgent: true },
    ],
    [
      "a diagnostic takes precedence over RUN",
      { connection: "connected", runtimeState: "RUN", diagnostic: fault },
      { key: "fault", urgent: true },
    ],
    [
      "E-STOP without a diagnostic",
      { connection: "connected", runtimeState: "ESTOP", diagnostic: null },
      { key: "estop", urgent: true },
    ],
    [
      "E-STOP takes precedence over a latched diagnostic",
      { connection: "connected", runtimeState: "ESTOP", diagnostic: fault },
      { key: "estop", urgent: true },
    ],
    [
      "connection failure takes precedence over E-STOP and a diagnostic",
      { connection: "failed", runtimeState: "ESTOP", diagnostic: fault },
      { key: "connectionError", urgent: true },
    ],
    [
      "a closed connection takes precedence over FAULT",
      { connection: "closed", runtimeState: "FAULT", diagnostic: fault },
      { key: "connectionError", urgent: true },
    ],
    [
      "connection failure takes precedence over normal status",
      { connection: "failed", runtimeState: "STOP", diagnostic: null },
      { key: "connectionError", urgent: true },
    ],
  ];

  it.each(cases)("selects the banner for %s", (_name, state, expected) => {
    expect(bannerFor(state)).toEqual(expected);
  });
});

it("asks for RUN after emergency stop release", () => {
  expect(
    bannerFor({
      connection: "connected",
      runtimeState: "STOP",
      diagnostic: null,
      emergencyReleased: true,
    }),
  ).toEqual({ key: "released", urgent: false });
});
