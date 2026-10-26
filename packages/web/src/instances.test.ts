import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import {
  filterInstances,
  instancesForSource,
  selectedInstance,
  watchedBodies,
} from "./instances.js";

function project() {
  const result = compileProject(
    [
      `PROGRAM Main VAR unit: Outer; motors: ARRAY[-1..1] OF Derived; link: REF_TO Base; END_VAR END_PROGRAM`,
      `PROGRAM Unused END_PROGRAM`,
      `FUNCTION_BLOCK Base VAR n: INT; END_VAR END_FUNCTION_BLOCK`,
      `FUNCTION_BLOCK Derived EXTENDS Base VAR child: Base; END_VAR END_FUNCTION_BLOCK`,
      `FUNCTION_BLOCK Outer VAR baseMember: Base; END_VAR END_FUNCTION_BLOCK`,
      `FUNCTION_BLOCK Uninstantiated END_FUNCTION_BLOCK`,
    ],
    [],
    `CONFIGURATION C
VAR_GLOBAL globalMotor: Derived; END_VAR
RESOURCE R ON Cpu
VAR_GLOBAL globalArray: ARRAY[2..3] OF Base; END_VAR
TASK T(INTERVAL := T#10ms, PRIORITY := 0);
PROGRAM Second WITH T: Main;
PROGRAM First WITH T: Main;
END_RESOURCE END_CONFIGURATION`,
  );
  expect(result.diagnostics).toEqual([]);
  return result.ir!;
}

it("lists configured PROGRAM instances in resource order and omits unused sources", () => {
  const ir = project();
  expect(instancesForSource(ir, "main")).toEqual([
    { path: "Second", type: "Main" },
    { path: "First", type: "Main" },
  ]);
  expect(instancesForSource(ir, "Unused")).toEqual([]);
  expect(instancesForSource(ir, "Uninstantiated")).toEqual([]);
});

it("lists derived, nested, global and array instances in monitor order without following references", () => {
  const instances = instancesForSource(project(), "Base");
  expect(instances.map((instance) => instance.path)).toEqual([
    "Second.UNIT.BASEMEMBER",
    "Second.MOTORS[-1]",
    "Second.MOTORS[-1].CHILD",
    "Second.MOTORS[0]",
    "Second.MOTORS[0].CHILD",
    "Second.MOTORS[1]",
    "Second.MOTORS[1].CHILD",
    "First.UNIT.BASEMEMBER",
    "First.MOTORS[-1]",
    "First.MOTORS[-1].CHILD",
    "First.MOTORS[0]",
    "First.MOTORS[0].CHILD",
    "First.MOTORS[1]",
    "First.MOTORS[1].CHILD",
    "GLOBALMOTOR",
    "GLOBALMOTOR.CHILD",
    "GLOBALARRAY[2]",
    "GLOBALARRAY[3]",
  ]);
  expect(instances.find((instance) => instance.path === "Second.MOTORS[-1]")?.type).toBe("Derived");
  expect(filterInstances(instances, "derived").map((instance) => instance.path)).toEqual([
    "Second.MOTORS[-1]",
    "Second.MOTORS[0]",
    "Second.MOTORS[1]",
    "First.MOTORS[-1]",
    "First.MOTORS[0]",
    "First.MOTORS[1]",
    "GLOBALMOTOR",
  ]);
  expect(filterInstances(instances, "first.motors[0]")).toHaveLength(2);
});

it("puts base members before derived members", () => {
  const ir = compileProject([
    "PROGRAM Main VAR a: Derived; END_VAR END_PROGRAM",
    "FUNCTION_BLOCK Motor END_FUNCTION_BLOCK",
    "FUNCTION_BLOCK Base VAR old: Motor; END_VAR END_FUNCTION_BLOCK",
    "FUNCTION_BLOCK Derived EXTENDS Base VAR own: Motor; END_VAR END_FUNCTION_BLOCK",
  ]).ir!;
  expect(instancesForSource(ir, "Motor").map((i) => i.path)).toEqual([
    "mainInstance.A.OLD",
    "mainInstance.A.OWN",
  ]);
});

it("uses remembered choices when present and otherwise defaults to the first instance", () => {
  const ir = project();
  expect(selectedInstance(ir, "Main", {})?.path).toBe("Second");
  expect(selectedInstance(ir, "Base", {})?.path).toBe("Second.UNIT.BASEMEMBER");
  expect(selectedInstance(ir, "Main", { MAIN: "First" })?.path).toBe("First");
  expect(selectedInstance(ir, "Base", { BASE: "missing" })?.path).toBe("Second.UNIT.BASEMEMBER");
  expect(selectedInstance(ir, "Unused", {})).toBeUndefined();
  expect(watchedBodies(ir, { MAIN: "First", BASE: "GLOBALMOTOR" }, "Base")).toEqual([
    { pou: "Main", instance: "First" },
    { pou: "Base", instance: "GLOBALMOTOR" },
  ]);
  expect(watchedBodies(ir, {}, "Main")).toEqual([{ pou: "Main", instance: "Second" }]);
});

it("lists class instances including derived classes in monitor order and watches functions without an instance", () => {
  const result = compileProject([
    `PROGRAM Main VAR a: Child; b: Parent; link: REF_TO Parent; END_VAR END_PROGRAM`,
    `CLASS Parent END_CLASS`,
    `CLASS Child EXTENDS Parent END_CLASS`,
    `FUNCTION F: INT F := 1; END_FUNCTION`,
  ]);
  expect(result.diagnostics).toEqual([]);
  const ir = result.ir!;
  expect(instancesForSource(ir, "Parent")).toEqual([
    { path: "mainInstance.A", type: "Child" },
    { path: "mainInstance.B", type: "Parent" },
  ]);
  expect(selectedInstance(ir, "Parent", {})?.path).toBe("mainInstance.A");
  expect(watchedBodies(ir, {}, "Parent")).toContainEqual({
    pou: "Parent",
    instance: "mainInstance.A",
  });
  expect(instancesForSource(ir, "F")).toEqual([]);
  expect(watchedBodies(ir, {}, "F")).toContainEqual({ pou: "F", instance: null });
});

it("localizes function callers with and without an instance, or reports that no call was recorded", async () => {
  const { functionCallLabel } = await import("./instances.js");
  const { catalogs } = await import("./catalog.js");
  const snapshot: import("@benchtop-plc/core").RuntimeSnapshot = {
    scanCount: 1,
    tasks: [],
    lastExecutionTimeMs: 0,
    inputs: [],
    outputs: [],
    variables: [],
    forced: [],
    annotations: [
      {
        pou: "F",
        instance: null,
        scanCount: 1,
        lines: {},
        caller: { pou: "Main", instance: "mainInstance", line: 12 },
      },
    ],
  };
  expect(functionCallLabel(snapshot, "f", catalogs.en)).toBe(
    "Called from Main (mainInstance), line 12",
  );
  expect(functionCallLabel(snapshot, "f", catalogs.ja)).toBe(
    "呼び出し元: Main (mainInstance)、12行目",
  );
  snapshot.annotations[0]!.caller!.instance = null;
  snapshot.annotations[0]!.caller!.pou = "Outer";
  expect(functionCallLabel(snapshot, "F", catalogs.en)).toBe("Called from Outer, line 12");
  expect(functionCallLabel(snapshot, "F", catalogs.ja)).toBe("呼び出し元: Outer、12行目");
  expect(functionCallLabel(null, "F", catalogs.en)).toBe("No call recorded yet");
  expect(functionCallLabel(snapshot, "Unused", catalogs.ja)).toBe(
    "まだ呼び出しが記録されていません",
  );
});
