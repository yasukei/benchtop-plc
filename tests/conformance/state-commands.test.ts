import { readFileSync } from "node:fs";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable, type DebugStepKind } from "@benchtop-plc/core";
import {
  createRuntime,
  RuntimeCommandRejected,
  VirtualClock,
  VirtualTicker,
} from "@benchtop-plc/runtime";
import { describe, expect, it } from "vitest";

const states = ["S", "R", "F", "ES", "ER", "EF", "HS", "HR"] as const;
type State = (typeof states)[number];
const commands = [
  "run",
  "stop",
  "single scan",
  "set cycle",
  "set cycle (explicit)",
  "cold reset",
  "warm restart",
  "load",
  "emergency stop",
  "release",
  "continue",
  "debug step",
  "write",
  "force",
  "run-time error",
  "internal-error FAULT",
] as const;
type Command = (typeof commands)[number];

const markdown = readFileSync(
  new URL("../../docs/adr/0022-operating-state-command-matrix.md", import.meta.url),
  "utf8",
);
const rows = markdown
  .split("\n")
  .filter((line) => line.startsWith("|"))
  .map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
const cases = rows.slice(2).flatMap(([command, ...cells]) => {
  if (!commands.includes(command as Command)) throw new Error(`Unknown matrix command: ${command}`);
  return cells.flatMap((outcome, index) => {
    const initial = states[index];
    if (!initial) throw new Error("Unexpected state column");
    if (outcome === "—") return [];
    const kinds: DebugStepKind[] = command === "debug step" ? ["into", "over", "out"] : ["into"];
    const faults =
      initial === "F" || initial === "EF"
        ? (["language", "internal"] as const)
        : (["language"] as const);
    return faults.flatMap((fault) =>
      kinds.map((kind) => ({ command: command as Command, initial, outcome, fault, kind })),
    );
  });
});

const source = `PROGRAM Main
VAR
  x : DINT;
  divisor : DINT := 1;
  q AT %QX0.0 : BOOL;
END_VAR
VAR RETAIN kept : DINT := 7; END_VAR
x := x + 1;
q := TRUE;
x := x / divisor;
END_PROGRAM`;
const configuration = `CONFIGURATION C
RESOURCE R ON PLC
TASK Cyclic(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM mainInstance WITH Cyclic : Main;
END_RESOURCE
END_CONFIGURATION`;

function setup(initial: State, fault: "language" | "internal", explicit = false) {
  const compiled = compileProject([source], [], explicit ? configuration : undefined);
  expect(compiled.diagnostics).toEqual([]);
  const ir = compiled.ir!;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const id = (name: string) =>
    ir.variables.findIndex((variable) => variable.key === `MAININSTANCE.${name.toUpperCase()}`);
  const cell = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  runtime.write(id("kept"), { dataType: "DINT", value: 99 });

  if (["R", "ER", "HR"].includes(initial)) {
    runtime.run();
    clock.advance(10);
  }
  if (initial === "F" || initial === "EF") {
    if (fault === "internal") runtime.fail();
    else {
      runtime.write(id("divisor"), { dataType: "DINT", value: 0 });
      runtime.step();
      expect(runtime.diagnostic?.code).toBe("runtime.division-by-zero");
      runtime.write(id("divisor"), { dataType: "DINT", value: 1 });
    }
  }
  if (initial === "HS" || initial === "HR") {
    runtime.setBreakpoints([{ pou: "Main", line: ir.programs[0]!.body[0]!.span.line }]);
    if (initial === "HS") runtime.step();
    else clock.advance(10);
  }
  if (initial.startsWith("E")) runtime.setEmergencyStop(true);

  function expectState(state: State) {
    if (state === "HS" || state === "HR") {
      expect(runtime.state).toBe("HALT");
      expect(runtime.halted?.operatingState).toBe(state === "HS" ? "STOP" : "RUN");
    } else {
      expect(runtime.state).toBe(
        state.startsWith("E") ? "ESTOP" : state === "S" ? "STOP" : state === "R" ? "RUN" : "FAULT",
      );
      expect(runtime.halted).toBeNull();
    }
    if (state === "F" || state === "EF") expect(runtime.diagnostic).not.toBeNull();
    else expect(runtime.diagnostic).toBeNull();
  }
  expectState(initial);
  return { runtime, clock, ir, id, cell, expectState };
}

describe("ADR 0022 command matrix", () => {
  it("covers every command and reachable state, with only impossible execution errors omitted", () => {
    expect(rows[0]).toEqual(["Command or event", ...states]);
    expect(rows.slice(2).map((row) => row[0])).toEqual(commands);
    for (const [command, ...cells] of rows.slice(2)) {
      expect(cells).toHaveLength(states.length);
      cells.forEach((cell, index) => {
        expect(cell).toMatch(
          /^(?:I|—|A:(?:S|R|F|ES|ER|EF|HS|HR|=|scan|resume|step)|E:(?:F|EF)|R:[HNC])$/,
        );
        expect(cell === "—").toBe(
          command === "run-time error" && ["F", "ES", "ER", "EF"].includes(states[index]!),
        );
      });
    }
  });

  it.each(cases)(
    "$initial × $command ($kind, $fault fault): $outcome",
    ({ initial, command, outcome, fault, kind }) => {
      const { runtime, clock, ir, id, cell, expectState } = setup(
        initial,
        fault,
        command === "set cycle (explicit)",
      );
      const before = runtime.snapshot();
      const diagnostic = runtime.diagnostic;
      const halted = runtime.halted;
      let rejection: RuntimeCommandRejected | undefined;
      try {
        switch (command) {
          case "run":
            runtime.run();
            break;
          case "stop":
            runtime.stop();
            break;
          case "single scan":
            runtime.step();
            break;
          case "set cycle":
          case "set cycle (explicit)":
            runtime.setCycle(20);
            break;
          case "cold reset":
            runtime.coldReset();
            break;
          case "warm restart":
            runtime.warmRestart();
            break;
          case "load":
            runtime.load(ir);
            break;
          case "emergency stop":
            runtime.setEmergencyStop(true);
            break;
          case "release":
            runtime.setEmergencyStop(false);
            break;
          case "continue":
            runtime.continue();
            break;
          case "debug step":
            runtime.debugStep(kind);
            break;
          case "write":
            runtime.write(id("kept"), { dataType: "DINT", value: 41 });
            break;
          case "force":
            runtime.force(id("kept"), { dataType: "DINT", value: 42 });
            break;
          case "run-time error":
            runtime.write(id("divisor"), { dataType: "DINT", value: 0 });
            if (initial === "R") clock.advance(10);
            else if (initial === "S") runtime.step();
            else runtime.continue();
            break;
          case "internal-error FAULT":
            runtime.fail();
            break;
        }
      } catch (error) {
        if (!(error instanceof RuntimeCommandRejected)) throw error;
        rejection = error;
      }

      if (outcome === "I" || outcome.startsWith("R:")) {
        if (outcome === "I") expect(rejection).toBeUndefined();
        else {
          const codes = {
            H: "runtime.halted",
            N: "runtime.not-halted",
            C: "runtime.configured-cycle",
          };
          expect(rejection?.diagnostic.code).toBe(codes[outcome.slice(2) as keyof typeof codes]);
        }
        expectState(initial);
        expect(runtime.snapshot()).toEqual(before);
        expect(runtime.diagnostic).toEqual(diagnostic);
        expect(runtime.halted).toEqual(halted);
      } else {
        expect(rejection).toBeUndefined();
        const result = outcome.slice(2);
        let expected: string = result;
        if (result === "=") expected = initial;
        if (result === "scan") expected = "S";
        if (result === "resume") expected = initial === "HS" ? "S" : "R";
        if (result === "step") expected = kind === "out" ? (initial === "HS" ? "S" : "R") : initial;
        expect(states).toContain(expected);
        expectState(expected as State);
        if (["cold reset", "warm restart", "load"].includes(command)) {
          expect(cell("kept")).toMatchObject({ value: command === "warm restart" ? 99 : 7 });
          expect(runtime.snapshot()).toMatchObject({ scanCount: 0, forced: [] });
        } else if (command === "internal-error FAULT") {
          expect(runtime.diagnostic).toEqual({
            code: "runtime.internal-error",
            severity: "error",
            args: {},
          });
        } else if (command === "run-time error") {
          expect(runtime.diagnostic?.code).toBe("runtime.division-by-zero");
        } else expect(runtime.diagnostic).toEqual(diagnostic);
        if (command === "write")
          expect(cell("kept")).toMatchObject({ value: initial === "R" ? 99 : 41 });
        if (command === "force") expect(runtime.snapshot().forced).toContain(id("kept"));
        if (command === "single scan")
          expect(runtime.snapshot().scanCount).toBe(before.scanCount + 1);
      }

      if (["STOP", "FAULT", "ESTOP"].includes(runtime.state)) {
        expect(runtime.snapshot().outputs.every((byte) => byte === 0)).toBe(true);
      }
      if (runtime.state === "ESTOP") {
        const pending = runtime.diagnostic;
        runtime.setEmergencyStop(false);
        expect(runtime.state).toBe(pending ? "FAULT" : "STOP");
        expect(runtime.diagnostic).toEqual(pending);
      }
      runtime.stop();
    },
  );
});
