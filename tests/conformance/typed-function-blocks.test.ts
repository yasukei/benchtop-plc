import { describe, expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import type { ScalarValue } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function setup(declarations: string, body: string) {
  const result = compile(`PROGRAM P VAR ${declarations} END_VAR ${body} END_PROGRAM`);
  expect(result.diagnostics).toEqual([]);
  if (!result.ir) throw new Error("Expected compiled IR");
  const ir = result.ir;
  const clock = new VirtualClock();
  let writes: Record<string, ScalarValue> = {};
  const runtime = createRuntime({
    clock,
    ticker: new VirtualTicker(clock),
    stages: {
      applyPendingWrites(memory) {
        for (const [name, value] of Object.entries(writes)) {
          const index = ir.variables.findIndex((variable) => variable.name === name);
          if (index < 0) throw new Error(`Unknown variable ${name}`);
          memory.write(index, value);
        }
      },
    },
  });
  runtime.load(ir);
  function scan(inputs: Record<string, ScalarValue> = {}, advance = 0) {
    writes = inputs;
    clock.advance(advance);
    const snapshot = runtime.scanOnce();
    expect(runtime.diagnostic).toBeNull();
    return Object.fromEntries(
      ir.variables.flatMap((variable, index) => {
        const cell = snapshot.variables[index]!;
        return cell.kind === "scalar" ? [[variable.name, cell.value]] : [];
      }),
    );
  }
  return { runtime, scan };
}

it.each(["SR", "RS"])("%s retains Q1, applies dominance and cold resets", (kind) => {
  const { scan, runtime } = setup(
    `latch: ${kind}; s, r, q: BOOL;`,
    `latch(${kind === "SR" ? "S1 := s, R := r" : "S := s, R1 := r"}); q := latch.Q1;`,
  );
  expect(scan().q).toBe(false);
  expect(scan({ s: true }).q).toBe(true);
  expect(scan({ s: false }).q).toBe(true);
  expect(scan({ r: true }).q).toBe(false);
  expect(scan({ s: true }).q).toBe(kind === "SR");
  expect(scan({ s: false, r: false }).q).toBe(kind === "SR");
  runtime.coldReset();
  expect(scan().q).toBe(false);
});

const counterTypes = ["INT", "DINT", "LINT", "UDINT", "ULINT"] as const;
const limits = {
  INT: [-32768n, 32767n],
  DINT: [-2147483648n, 2147483647n],
  LINT: [-(1n << 63n), (1n << 63n) - 1n],
  UDINT: [0n, 4294967295n],
  ULINT: [0n, (1n << 64n) - 1n],
} as const;
function value(type: (typeof counterTypes)[number], n: bigint): string | number {
  return type === "LINT" || type === "ULINT" ? String(n) : Number(n);
}

describe.each(["", ...counterTypes.map((type) => `_${type}`)])("CTUD%s", (suffix) => {
  const type = (suffix.slice(1) || "INT") as (typeof counterTypes)[number];
  it("counts both directions, cancels simultaneous edges and prioritizes reset over load", () => {
    const { scan, runtime } = setup(
      `c: CTUD${suffix}; cu, cd, r, ld, qu, qd: BOOL; pv, cv: ${type};`,
      "c(CU := cu, CD := cd, R := r, LD := ld, PV := pv); cv := c.CV; qu := c.QU; qd := c.QD;",
    );
    const expected = (cv: bigint, qu: boolean, qd: boolean) => ({ cv: value(type, cv), qu, qd });
    expect(scan({ pv: value(type, 2n) })).toMatchObject(expected(0n, false, true));
    expect(scan({ cu: true })).toMatchObject(expected(1n, false, false));
    expect(scan()).toMatchObject(expected(1n, false, false));
    scan({ cu: false });
    expect(scan({ cu: true })).toMatchObject(expected(2n, true, false));
    expect(scan({ cu: false, cd: true })).toMatchObject(expected(1n, false, false));
    scan({ cd: false });
    expect(scan({ cu: true, cd: true })).toMatchObject(expected(1n, false, false));
    // CU stays high; only the new CD edge counts on the next call.
    scan({ cd: false });
    expect(scan({ cd: true })).toMatchObject(expected(0n, false, true));
    expect(scan({ ld: true })).toMatchObject(expected(2n, true, false));
    expect(scan({ r: true })).toMatchObject(expected(0n, false, true));
    expect(scan({ r: false, ld: false })).toMatchObject(expected(0n, false, true));
    runtime.coldReset();
    expect(scan()).toMatchObject(expected(0n, true, true));
  });

  it("loads either type boundary and saturates without wrapping", () => {
    const [min, max] = limits[type];
    const { scan } = setup(
      `c: CTUD${suffix}; cu, cd, ld: BOOL; pv, cv: ${type};`,
      "c(CU := cu, CD := cd, LD := ld, PV := pv); cv := c.CV;",
    );
    scan({ ld: true, pv: value(type, max - 1n) });
    expect(scan({ ld: false, cu: true }).cv).toBe(value(type, max));
    scan({ cu: false });
    expect(scan({ cu: true }).cv).toBe(value(type, max));
    expect(scan({ cu: false, cd: true }).cv).toBe(value(type, max - 1n));
    scan({ ld: true, cd: false, pv: value(type, min + 1n) });
    expect(scan({ ld: false, cd: true }).cv).toBe(value(type, min));
    scan({ cd: false });
    expect(scan({ cd: true }).cv).toBe(value(type, min));
    expect(scan({ cd: false, cu: true }).cv).toBe(value(type, min + 1n));
  });
});

it.each(counterTypes)(
  "executes CTU_%s and CTD with exact typed PV/CV and retained edge history",
  (type) => {
    const { scan, runtime } = setup(
      `u: CTU_${type}; d: CTD_${type}; edge, r, ld, qu, qd: BOOL; pv, up, down: ${type};`,
      `u(CU := edge, R := r, PV := pv); d(CD := edge, LD := ld, PV := pv);
     up := u.CV; down := d.CV; qu := u.Q; qd := d.Q;`,
    );
    expect(scan({ pv: value(type, 2n), ld: true })).toMatchObject({
      up: value(type, 0n),
      down: value(type, 2n),
      qu: false,
      qd: false,
    });
    expect(scan({ ld: false, edge: true })).toMatchObject({
      up: value(type, 1n),
      down: value(type, 1n),
    });
    expect(scan()).toMatchObject({ up: value(type, 1n), down: value(type, 1n) });
    scan({ edge: false });
    expect(scan({ edge: true })).toMatchObject({
      up: value(type, 2n),
      down: value(type, 0n),
      qu: true,
      qd: true,
    });
    expect(scan({ r: true, ld: true })).toMatchObject({
      up: value(type, 0n),
      down: value(type, 2n),
    });
    expect(scan({ r: false, ld: false })).toMatchObject({
      up: value(type, 0n),
      down: value(type, 2n),
    });
    runtime.coldReset();
    expect(scan()).toMatchObject({
      up: value(type, 0n),
      down: value(type, 0n),
      qu: true,
      qd: true,
    });
  },
);

it.each(["TON", "TOF", "TP"])(
  "%s_TIME matches its unsuffixed timer, including negative PT",
  (kind) => {
    const { scan } = setup(
      `a: ${kind}; b: ${kind}_TIME; input, qa, qb: BOOL; pt, ea, eb: TIME;`,
      "a(IN := input, PT := pt); b(IN := input, PT := pt); qa := a.Q; qb := b.Q; ea := a.ET; eb := b.ET;",
    );
    for (const [input, pt, advance] of [
      [false, 10, 0],
      [true, 10, 0],
      [false, 10, 2],
      [true, 10, 7],
      [true, 10, 1],
      [false, -1, 1],
      [true, -1, 1],
    ] as const) {
      const state = scan({ input, pt }, advance);
      expect([state.qb, state.eb]).toEqual([state.qa, state.ea]);
    }
  },
);

it.each(["TON", "TOF", "TP"])(
  "%s_LTIME resolves a 1500us preset at its nanosecond boundary",
  (kind) => {
    const { scan, runtime } = setup(
      `timer: ${kind}_LTIME; input, q: BOOL; pt: LTIME := LT#1500us; et: LTIME;`,
      "timer(IN := input, PT := pt); q := timer.Q; et := timer.ET;",
    );
    if (kind === "TOF") scan({ input: true });
    expect(scan({ input: kind !== "TOF" })).toMatchObject({ q: kind !== "TON", et: "0" });
    expect(scan({}, 1.499999)).toMatchObject({ q: kind !== "TON", et: "1499999" });
    expect(scan({}, 0.000001)).toMatchObject({ q: kind === "TON", et: "1500000" });
    expect(scan({ pt: "2000000" }, 1)).toMatchObject({ q: kind === "TON", et: "2000000" });
    if (kind === "TON") expect(scan({ input: false }).et).toBe("0");
    if (kind === "TOF") expect(scan({ input: true }).et).toBe("0");
    if (kind === "TP") expect(scan({ input: false }).et).toBe("0");
    runtime.coldReset();
    expect(scan({ input: true, pt: "-1" })).toMatchObject({ q: kind !== "TP", et: "0" });
    if (kind === "TOF") expect(scan({ input: false })).toMatchObject({ q: false, et: "0" });
  },
);

it.each(["TON", "TOF", "TP"])(
  "%s_LTIME retains an exact PT beyond Number's integer precision",
  (kind) => {
    const { scan } = setup(
      `timer: ${kind}_LTIME; input, q: BOOL; et: LTIME;`,
      "timer(IN := input, PT := LT#9007199254740993ns); q := timer.Q; et := timer.ET;",
    );
    if (kind === "TOF") scan({ input: true });
    scan({ input: kind !== "TOF" });
    expect(scan({}, 9007199255)).toMatchObject({ q: kind === "TON", et: "9007199254740993" });
  },
);

it.each(["TON_TIME", "TOF_TIME", "TP_TIME"])("%s keeps TIME PT and rejects LTIME", (kind) => {
  const result = compile(`PROGRAM P VAR t: ${kind}; END_VAR t(PT := LT#1ms); END_PROGRAM`);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((item) => item.code)).toContain("type.assign-mismatch");
});

it.each(["TON", "TOF", "TP"])("%s selects LTIME from its preset", (kind) => {
  const result = compile(`PROGRAM P VAR t: ${kind}; END_VAR t(PT := LT#1ms); END_PROGRAM`);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir!.variables[0]).toMatchObject({ fbType: `${kind}_LTIME` });
});
