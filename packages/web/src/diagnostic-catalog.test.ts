import { describe, expect, expectTypeOf, it } from "vitest";
import type { DiagnosticArgs, DiagnosticCode } from "@benchtop-plc/core";
import { compile } from "@benchtop-plc/compiler";
import { en, ja } from "./catalog.js";
import {
  diagnosticEn,
  diagnosticJa,
  formatDiagnostic,
  type DiagnosticCatalog,
} from "./diagnostic-catalog.js";

const examples = {
  "project.invalid-xml": {},
  "project.missing": { path: "project/types" },
  "project.unsupported": { path: "project/types/dataTypes" },
  "project.invalid": { path: "project/task/@interval" },
  "project.dropped-data": { name: "https://vendor.example/data" },
  "project.stale-source": {},
  "lex.unterminated-comment": {},
  "lex.invalid-character": { character: "@" },
  "lex.malformed-direct-address": { address: "%IX0." },
  "lex.malformed-number": { literal: "16#GG" },
  "syntax.expected-token": { expected: ";", found: "END_PROGRAM" },
  "syntax.expected-identifier": { found: ":" },
  "syntax.reserved-identifier": { name: "IF" },
  "syntax.assignment-operator": {},
  "syntax.unexpected-eof": {},
  "syntax.missing-end": { expected: "END_IF" },
  "decl.unknown-type": { name: "STRING" },
  "decl.duplicate": { name: "Counter" },
  "decl.name-collision": { name: "ABS", kind: "function" },
  "decl.direct-address-type": { name: "Counter", type: "INT" },
  "decl.at-multiple-names": {},
  "decl.address-out-of-range": { address: "%IX1.0" },
  "decl.nonconstant-initializer": { name: "Counter" },
  "decl.fb-initializer": { name: "Timer" },
  "name.undeclared": { name: "Missing" },
  "type.invalid-constant": {},
  "type.case-label-not-constant": {},
  "fb.duplicate-input": { name: "Timer", member: "IN" },
  "type.assign-mismatch": { from: "REAL", to: "INT", hint: "explicit-conversion" },
  "type.operand-mismatch": { operator: "+", left: "BOOL", right: "INT" },
  "type.condition-not-bool": { statement: "WHILE" },
  "type.case-selector-not-integer": { type: "REAL" },
  "type.case-label-not-integer": { type: "BOOL" },
  "type.for-variable-not-integer": { name: "Index", type: "REAL" },
  "type.for-bound-not-integer": { bound: "step", type: "LREAL" },
  "flow.exit-outside-loop": {},
  "fb.not-function-block": { name: "Counter" },
  "fb.unknown-member": { name: "Timer", member: "MISSING" },
  "fb.output-not-writable": { name: "Timer", member: "Q" },
  "fb.instance-as-value": { name: "Timer" },
  "fb.call-in-expression": { name: "Timer" },
  "call.unknown-function": { name: "MISSING" },
  "call.argument-count": { name: "LIMIT", min: 3, max: 3, found: 2 },
  "call.argument-type": { name: "ABS", index: 0, expected: ["INT", "REAL"], found: "BOOL" },
  "runtime.invalid-value": {},
  "runtime.division-by-zero": {},
  "runtime.watchdog": { limit: 10000 },
  "runtime.for-by-zero": {},
} satisfies DiagnosticArgs;

describe("translation catalogs", () => {
  it("has exactly matching, nonempty shell messages", () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    for (const catalog of [en, ja]) {
      expect(Object.values(catalog).every((message) => message.trim().length > 0)).toBe(true);
    }
  });

  it("covers every core diagnostic code in both languages", () => {
    expectTypeOf<keyof typeof examples>().toEqualTypeOf<DiagnosticCode>();
    expectTypeOf<keyof typeof diagnosticEn>().toEqualTypeOf<DiagnosticCode>();
    expectTypeOf<keyof typeof diagnosticJa>().toEqualTypeOf<DiagnosticCode>();
    for (const catalog of [diagnosticEn, diagnosticJa]) {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(examples).sort());
    }
  });

  it("renders every diagnostic with its arguments in both languages", () => {
    function check<C extends DiagnosticCode>(
      code: C,
      args: DiagnosticArgs[C],
      catalog: DiagnosticCatalog,
    ) {
      const template = catalog[code];
      const message = template(args);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/undefined|null|\$\{/);
      // Internal labels and zero-based positions are translated or reformatted.
      for (const [key, value] of Object.entries(args)) {
        if (value === null || ["hint", "kind", "bound", "index"].includes(key)) continue;
        for (const part of Array.isArray(value) ? value : [value]) {
          expect(message).toContain(String(part));
        }
      }
    }
    for (const code of Object.keys(examples) as DiagnosticCode[]) {
      for (const catalog of [diagnosticEn, diagnosticJa]) check(code, examples[code], catalog);
    }
  });

  it("renders real compiler diagnostics without altering source identifiers", () => {
    const result = compile("PROGRAM Main\nVAR x : INT; END_VAR\nx := Missing;\nEND_PROGRAM");
    const diagnostic = result.diagnostics.find((item) => item.code === "name.undeclared");
    expect(diagnostic).toBeDefined();
    expect(formatDiagnostic("en", diagnostic!)).toBe("Undeclared identifier: Missing.");
    expect(formatDiagnostic("ja", diagnostic!)).toBe("宣言されていない識別子です: Missing。");
  });

  it("interpolates runtime limits, hints, types, token identifiers and count variants", () => {
    const fault = { code: "runtime.watchdog", severity: "error", args: { limit: 37 } } as const;
    expect(formatDiagnostic("en", fault)).toBe("Loop iteration limit (37) exceeded.");
    expect(formatDiagnostic("ja", fault)).toContain("37回");
    for (const [catalog, hint, token] of [
      [diagnosticEn, "explicit conversion", "direct address"],
      [diagnosticJa, "明示的な型変換", "直接アドレス"],
    ] as const) {
      expect(
        catalog["type.assign-mismatch"]({ from: "REAL", to: "INT", hint: "explicit-conversion" }),
      ).toContain(hint);
      expect(catalog["type.assign-mismatch"]({ from: "REAL", to: "INT" })).not.toContain(hint);
      expect(catalog["syntax.expected-token"]({ expected: "address", found: "Foo" })).toContain(
        token,
      );
      expect(
        catalog["type.operand-mismatch"]({ operator: "NOT", left: "REAL", right: null }),
      ).not.toContain("null");
      expect(
        catalog["call.argument-type"]({
          name: "ABS",
          index: 1,
          expected: ["INT", "REAL"],
          found: "BOOL",
        }),
      ).toMatch(/2.*ABS|ABS.*2/);
      for (const max of [null, 2, 4]) {
        const message = catalog["call.argument-count"]({ name: "MIN", min: 2, max, found: 1 });
        expect(message).toContain("MIN");
        expect(message).toContain("2");
        expect(message).toContain("1");
        if (max === 4) expect(message).toContain("4");
      }
    }
  });
});
