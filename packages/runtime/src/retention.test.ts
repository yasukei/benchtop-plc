import { expect, it } from "vitest";
import type {
  FunctionBlockType,
  ProgramIR,
  ScalarVariable,
  RetentiveRecord,
} from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "./index.js";

const span = { line: 1, column: 1, endLine: 1, endColumn: 2 };
const scalar = (
  name: string,
  dataType: ScalarVariable["dataType"] = "INT",
  initialValue: ScalarVariable["initialValue"] = 0,
): ScalarVariable =>
  ({
    kind: "scalar",
    name,
    key: name.toUpperCase(),
    span,
    dataType,
    initialValue,
    retain: true,
  }) as ScalarVariable;
const block = (name: string, fbType: FunctionBlockType) => ({
  kind: "functionBlock" as const,
  name,
  key: name.toUpperCase(),
  span,
  fbType,
  retain: true,
  initialValue: null,
});
function setup(variables: ProgramIR["variables"]) {
  const ir: ProgramIR = { kind: "program", name: "P", span, variables, body: [] };
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  return { runtime, ir };
}

it("matches leaves by case-insensitive path and type after a program change, truncating strings", () => {
  const old = setup([
    scalar("P.a"),
    scalar("P.removed"),
    scalar("P.changed"),
    scalar("P.text", { kind: "string", base: "STRING", length: 10 }, "abcdef"),
  ]);
  old.runtime.write(0, { dataType: "INT", value: 42 });
  const records = JSON.parse(JSON.stringify(old.runtime.retentiveRecords())) as RetentiveRecord[];
  const next = setup([
    scalar("p.A"),
    scalar("P.changed", "DINT"),
    scalar("P.new", "INT", 7),
    scalar("P.text", { kind: "string", base: "STRING", length: 3 }, "x"),
  ]);
  expect(next.runtime.restoreRetentive(records).sort()).toEqual([
    "P.changed",
    "P.new",
    "P.removed",
  ]);
  expect(next.runtime.snapshot().variables).toMatchObject([
    { value: 42 },
    { value: 0 },
    { value: 7 },
    { value: "abc" },
  ]);
  expect(next.runtime.state).toBe("STOP");
});

it("rejects an entire block record when CTU changes to CTD, including CV", () => {
  const old = setup([block("P.ctr", "CTU"), scalar("P.kept")]);
  const records = old.runtime.retentiveRecords();
  const record = records[0]!;
  if (record.kind !== "block") throw new Error("Expected block record");
  record.outputs[1] = { dataType: "INT", value: 9 };
  record.state = { previousUp: true, previousDown: false };
  const next = setup([block("P.ctr", "CTD"), scalar("P.kept")]);
  expect(next.runtime.restoreRetentive(records)).toEqual(["P.ctr"]);
  expect(next.runtime.snapshot().variables[0]).toMatchObject({
    inputs: [{ value: false }, { value: false }, { value: 0 }],
    outputs: [{ value: true }, { value: 0 }],
  });
});

it.each(["CTU_DINT", "CTUD_LINT", "R_TRIG", "F_TRIG", "SR", "RS"] as const)(
  "round trips %s private state and ports as one independent block record",
  (fbType) => {
    const first = setup([block("P.block", fbType)]);
    const records = first.runtime.retentiveRecords();
    const record = records[0]!;
    if (record.kind !== "block") throw new Error("Expected block record");
    const output = record.outputs.at(-1)!;
    if (output.dataType === "BOOL") output.value = true;
    else if (output.dataType === "LINT") output.value = "9007199254740993";
    else if (output.dataType === "DINT") output.value = 123;
    if ("previous" in record.state) record.state.previous = true;
    if ("previousUp" in record.state) record.state.previousUp = true;
    const next = setup([block("p.BLOCK", fbType)]);
    expect(next.runtime.restoreRetentive(records)).toEqual([]);
    expect(next.runtime.retentiveRecords()).toEqual([{ ...record, path: "p.BLOCK" }]);
    const cloned = next.runtime.retentiveRecords();
    if (cloned[0]?.kind === "block") cloned[0].outputs[0]!.value = false;
    expect(next.runtime.retentiveRecords()).toEqual([{ ...record, path: "p.BLOCK" }]);
  },
);

it("excludes timers and references and reports leaves that are no longer retained", () => {
  const old = setup([scalar("P.x")]);
  const next = setup([
    { ...scalar("P.x"), retain: false },
    block("P.timer", "TON"),
    {
      kind: "reference",
      name: "P.ptr",
      key: "P.PTR",
      span,
      retain: true,
      dataType: { kind: "reference", target: "INT" },
      initialValue: null,
    },
  ]);
  expect(next.runtime.restoreRetentive(old.runtime.retentiveRecords())).toEqual(["P.x"]);
  expect(next.runtime.retentiveRecords()).toEqual([]);
});

it("rejects corrupt leaf values and private state without partially restoring block ports", () => {
  const { runtime } = setup([scalar("P.n"), block("P.ctr", "CTU")]);
  const records = runtime.retentiveRecords();
  const leaf = records[0]!,
    ctr = records[1]!;
  if (leaf.kind !== "leaf" || ctr.kind !== "block") throw new Error("Expected records");
  leaf.value = { dataType: "INT", value: 40000 };
  ctr.outputs[1] = { dataType: "INT", value: 9 };
  ctr.state = { previousUp: null, previousDown: false };
  expect(runtime.restoreRetentive(records)).toEqual(["P.n", "P.ctr"]);
  expect(runtime.snapshot().variables).toMatchObject([
    { value: 0 },
    { outputs: [{ value: false }, { value: 0 }] },
  ]);
});

it("cold reset and load initialize retained values", () => {
  const { runtime, ir } = setup([scalar("P.n", "INT", 3)]);
  runtime.write(0, { dataType: "INT", value: 10 });
  runtime.coldReset();
  expect(runtime.snapshot().variables[0]).toMatchObject({ value: 3 });
  runtime.write(0, { dataType: "INT", value: 20 });
  runtime.load(ir);
  expect(runtime.snapshot().variables[0]).toMatchObject({ value: 3 });
});
