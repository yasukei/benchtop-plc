import { compile, compileProject } from "@benchtop-plc/compiler";
import { standardFunctionBlocks } from "@benchtop-plc/core";
import type { IoImage, ProgramIR, RuntimeSnapshot, ScalarValue } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

export interface TraceStep {
  label: string;
  set: Record<string, ScalarValue>;
  scans?: number;
  advanceMs?: number;
  expect: Record<string, ScalarValue>;
}

export type Trace =
  | { kind: "run"; cycleMs: number; steps: TraceStep[] }
  | { kind: "compile-error"; diagnostics: string[] };

function object(value: unknown, keys?: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (keys && !keys.includes(key)) throw new Error(`Unknown trace field: ${key}`);
  return record;
}

function values(value: unknown): Record<string, ScalarValue> {
  const record = object(value);
  for (const [key, item] of Object.entries(record)) {
    if (
      typeof item !== "boolean" &&
      typeof item !== "string" &&
      (typeof item !== "number" || !Number.isFinite(item))
    )
      throw new Error(`Expected a boolean, string or finite number for ${key}`);
  }
  return record as Record<string, ScalarValue>;
}

function nonnegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Expected nonnegative finite milliseconds or scan count");
  return value;
}

/** Validate JSON rather than letting misspelled fields silently weaken a test. */
export function parseTrace(value: unknown): Trace {
  const trace = object(value);
  if (trace.kind === "compile-error") {
    object(trace, ["kind", "diagnostics"]);
    if (
      !Array.isArray(trace.diagnostics) ||
      trace.diagnostics.length === 0 ||
      !trace.diagnostics.every((code: unknown) => typeof code === "string" && code.length > 0)
    )
      throw new Error("Expected a nonempty list of diagnostic codes");
    return { kind: trace.kind, diagnostics: trace.diagnostics as string[] };
  }
  object(trace, ["kind", "cycleMs", "steps"]);
  if (trace.kind !== "run") throw new Error("Expected trace kind run or compile-error");
  const cycleMs = nonnegative(trace.cycleMs);
  if (cycleMs === 0) throw new Error("cycleMs must be positive");
  if (!Array.isArray(trace.steps) || trace.steps.length === 0)
    throw new Error("Expected nonempty trace steps");
  const steps = trace.steps.map((item: unknown, index): TraceStep => {
    try {
      const step = object(item, ["label", "set", "scans", "advanceMs", "expect"]);
      if (typeof step.label !== "string" || step.label.length === 0)
        throw new Error("Expected a nonempty step label");
      if (step.scans !== undefined && step.advanceMs !== undefined)
        throw new Error("Use scans or advanceMs, not both");
      const scans = step.scans === undefined ? undefined : nonnegative(step.scans);
      if (scans !== undefined && !Number.isSafeInteger(scans))
        throw new Error("scans must be a safe integer");
      const advanceMs = step.advanceMs === undefined ? undefined : nonnegative(step.advanceMs);
      const expected = values(step.expect);
      if (Object.keys(expected).length === 0) throw new Error("Expected nonempty expectations");
      return {
        label: step.label,
        set: step.set === undefined ? {} : values(step.set),
        ...(scans === undefined ? {} : { scans }),
        ...(advanceMs === undefined ? {} : { advanceMs }),
        expect: expected,
      };
    } catch (error) {
      throw new Error(`Step ${index + 1}: ${String(error)}`, { cause: error });
    }
  });
  return { kind: trace.kind, cycleMs, steps };
}

function readValue(ir: ProgramIR, snapshot: RuntimeSnapshot, path: string): ScalarValue {
  const key = path.toUpperCase();
  const scalarIndex = ir.variables.findIndex((variable) => variable.key === key);
  const scalar = snapshot.variables[scalarIndex];
  if (scalar?.kind === "scalar") return scalar.value;
  const separator = key.lastIndexOf(".");
  const name = key.slice(0, separator),
    member = key.slice(separator + 1);
  const index = ir.variables.findIndex((variable) => variable.key === name);
  const variable = ir.variables[index],
    cell = snapshot.variables[index];
  if (variable?.kind === "functionBlock" && cell?.kind === "functionBlock") {
    const descriptor = standardFunctionBlocks[variable.fbType];
    for (const port of ["inputs", "outputs"] as const) {
      const memberIndex = descriptor[port].findIndex(([key]) => key === member);
      const value = cell[port][memberIndex];
      if (value) return value.value;
    }
  }
  throw new Error(`Unknown variable or function block member: ${path}`);
}

/** Execute only through public compiler/runtime APIs, with no real-time waits. */
export function runTrace(name: string, source: string | readonly string[], trace: Trace): void {
  const result = typeof source === "string" ? compile(source) : compileProject(source);
  const codes = result.diagnostics.map((diagnostic) => diagnostic.code).sort();
  if (trace.kind === "compile-error") {
    const expected = [...trace.diagnostics].sort();
    if (result.ir || JSON.stringify(codes) !== JSON.stringify(expected))
      throw new Error(
        `${name}: expected compilation failure ${JSON.stringify(expected)}, actual ${JSON.stringify(codes)} (IR ${result.ir ? "present" : "absent"})`,
      );
    return;
  }
  const ir = result.ir;
  if (!ir || codes.length > 0)
    throw new Error(`${name}: expected successful compilation, actual ${JSON.stringify(codes)}`);
  const clock = new VirtualClock();
  const image: IoImage = [false, false, false, false, false, false, false, false];
  let pending: [number, ScalarValue][] = [];
  const runtime = createRuntime({
    clock,
    ticker: new VirtualTicker(clock),
    intervalMs: trace.cycleMs,
    stages: {
      readInputs: () => [...image],
      applyPendingWrites(memory) {
        for (const [index, value] of pending) memory.write(index, value);
        pending = [];
      },
    },
  });
  runtime.load(ir);
  runtime.run();
  try {
    for (const [index, step] of trace.steps.entries()) {
      const context = `${name}: step ${index + 1} (${step.label})`;
      try {
        for (const [key, value] of Object.entries(step.set)) {
          const variableIndex = ir.variables.findIndex(
            (variable) => variable.key === key.toUpperCase(),
          );
          const variable = ir.variables[variableIndex];
          if (!variable || variable.kind !== "scalar" || variable.address?.area === "Q")
            throw new Error(`Cannot set input or scalar variable: ${key}`);
          if ((variable.dataType === "BOOL") !== (typeof value === "boolean"))
            throw new Error(`Wrong value type for ${key}`);
          if (variable.address?.area === "I") image[variable.address.bit] = Boolean(value);
          else pending.push([variableIndex, value]);
        }
        clock.advance(step.advanceMs ?? (step.scans ?? 0) * trace.cycleMs);
        if (runtime.diagnostic || runtime.state !== "RUN")
          throw new Error(`Unexpected runtime state ${runtime.state}: ${runtime.diagnostic?.code}`);
        const snapshot = runtime.snapshot();
        for (const [path, expected] of Object.entries(step.expect)) {
          const actual = readValue(ir, snapshot, path);
          if (actual !== expected)
            throw new Error(
              `variable ${path}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)} at ${clock.now()} ms (scan ${snapshot.scanCount})`,
            );
        }
      } catch (error) {
        throw new Error(`${context}: ${String(error)}`, { cause: error });
      }
    }
  } finally {
    runtime.stop();
  }
}
