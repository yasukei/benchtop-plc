import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { imageReadings } from "./io-image.js";
import { en, ja } from "./catalog.js";
import type { AppState } from "./store.js";

function state() {
  const ir = compileProject(
    [
      `PROGRAM Main VAR n AT %IW0 : INT; raw AT %ID1 : DWORD; sample AT %ID1 : REAL;
      memory AT %MW0 : WORD; END_VAR VAR_INPUT connected : LREAL; END_VAR END_PROGRAM`,
    ],
    [],
    `CONFIGURATION Plant RESOURCE Station ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 1); TASK Edge (SINGLE := %IX3.5, PRIORITY := 0);
    PROGRAM A WITH T : Main (connected := %IL2); END_RESOURCE END_CONFIGURATION`,
  ).ir!;
  expect(ir).toBeDefined();
  return {
    loadedIr: ir,
    layout: [
      { id: "1", kind: "led", label: "Lamp", address: "%QX63.7", color: "green", x: 0, y: 0 },
    ],
    runtimeState: "RUN",
    emergencyActive: false,
    snapshot: {
      inputs: [251, 255, 0, 0, 0, 0, 192, 127, ...Array<number>(56).fill(0)],
      outputs: [...Array<number>(63).fill(0), 128],
      variables: [],
      tasks: [],
      forced: [],
      annotations: [],
      scanCount: 0,
      lastExecutionTimeMs: 0,
    },
  } satisfies Pick<
    AppState,
    "loadedIr" | "layout" | "runtimeState" | "emergencyActive" | "snapshot"
  >;
}
it("lists only used addresses, preserving declaration/connection types and panel bits", () => {
  expect(imageReadings(state(), en).map((v) => [v.address, v.dataType, v.value])).toEqual([
    ["%IW0", "INT", "-5"],
    ["%ID1", "DWORD", "16#7FC00000"],
    ["%ID1", "REAL", "Invalid (16#7FC00000)"],
    ["%IL2", "LREAL", "0.0"],
    ["%IX3.5", "BOOL", "OFF"],
    ["%QX63.7", "BOOL", "ON"],
  ]);
  expect(imageReadings(state(), ja).find((v) => v.dataType === "REAL")?.value).toBe(
    "無効 (16#7FC00000)",
  );
});
it("masks all output views outside RUN and during emergency stop", () => {
  for (const runtimeState of ["STOP", "FAULT", "ESTOP", "RUN"] as const) {
    const source = state();
    const readings = imageReadings(
      { ...source, runtimeState, emergencyActive: runtimeState === "RUN" },
      en,
    );
    expect(readings.find((v) => v.address === "%QX63.7")).toMatchObject({
      value: "OFF",
      active: false,
    });
    expect(readings[0]?.value).toBe("-5");
  }
});

it("includes numeric panel bindings without program declarations and formats invalid displays", () => {
  const source = state();
  source.snapshot.outputs.splice(0, 8, 0, 0, 192, 127, 255, 255, 255, 255);
  const layout: AppState["layout"] = [
    {
      id: "1",
      kind: "numericInput",
      label: "In",
      address: "%IW0",
      dataType: "INT",
      x: 0,
      y: 0,
      color: "green",
    },
    {
      id: "2",
      kind: "numericDisplay",
      label: "Out",
      address: "%QD0",
      dataType: "REAL",
      x: 0,
      y: 0,
      color: "green",
    },
    {
      id: "3",
      kind: "numericDisplay",
      label: "Raw",
      address: "%QD1",
      dataType: "DWORD",
      x: 0,
      y: 0,
      color: "green",
    },
  ];
  expect(imageReadings({ ...source, loadedIr: undefined, layout }, en).map((v) => v.value)).toEqual(
    ["-5", "Invalid (16#7FC00000)", "16#FFFFFFFF"],
  );
  for (const runtimeState of ["STOP", "FAULT", "ESTOP"] as const)
    expect(
      imageReadings({ ...source, loadedIr: undefined, layout, runtimeState }, en).map(
        (v) => v.value,
      ),
    ).toEqual(["-5", "0.0", "16#00000000"]);
  expect(
    imageReadings({ ...source, loadedIr: undefined, layout, emergencyActive: true }, en).map(
      (v) => v.value,
    ),
  ).toEqual(["-5", "0.0", "16#00000000"]);
});
