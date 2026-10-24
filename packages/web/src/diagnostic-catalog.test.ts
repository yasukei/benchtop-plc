import { describe, expect, expectTypeOf, it } from "vitest";
import {
  formatType,
  type TypeDescriptor,
  type DiagnosticArgs,
  type DiagnosticCode,
} from "@benchtop-plc/core";
import { compile } from "@benchtop-plc/compiler";
import { en, ja } from "./catalog.js";
import {
  diagnosticEn,
  diagnosticJa,
  formatDiagnostic,
  type DiagnosticCatalog,
} from "./diagnostic-catalog.js";

const examples = {
  "global.not-found": { name: "g" },
  "global.type-mismatch": { name: "g" },
  "global.constant-mismatch": { name: "g" },
  "global.external-initializer": { name: "g" },

  "config.configuration-count": {},
  "config.resource-count": {},
  "config.task-count": {},
  "config.no-instances": {},
  "config.instance-limit": {},
  "config.name-collision": { name: "TON" },
  "config.unknown-task": { name: "Missing" },
  "config.missing-task": { name: "A" },
  "config.program-type": { name: "Counter" },
  "config.interval": {},
  "config.priority": {},
  "config.task-parameter": { name: "SINGLE" },
  "runtime.configured-cycle": {},
  "project.invalid-xml": {},
  "project.missing": { path: "project/types" },
  "project.unsupported": { path: "project/types/dataTypes" },
  "runtime.null-reference": {},
  "type.invalid-reference-target": {},
  "type.reference-initializer": {},
  "project.invalid": { path: "project/task/@interval" },
  "project.dropped-data": { name: "https://vendor.example/data" },
  "project.stale-source": {},
  "lex.unterminated-comment": {},
  "lex.unterminated-string": {},
  "lex.invalid-string-escape": {},
  "lex.invalid-string-character": {},
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
  "decl.type-cycle": { name: "Node" },
  "decl.structure-member-type": { name: "TON" },
  "decl.fb-array-form": { form: "named" },
  "decl.duplicate": { name: "Counter" },
  "decl.name-collision": { name: "ABS", kind: "function" },
  "decl.direct-address-type": { name: "Counter", type: "INT" },
  "decl.temp-address": {},
  "decl.at-multiple-names": {},
  "decl.address-out-of-range": { address: "%IX1.0" },
  "decl.nonconstant-initializer": { name: "Counter" },
  "decl.fb-initializer": { name: "Timer" },
  "decl.constant-section": { section: "VAR_INPUT" },
  "decl.constant-type": {},
  "decl.constant-address": {},
  "decl.constant-not-writable": { name: "N" },
  "decl.constant-order": { name: "N" },
  "decl.open-array-section": {},
  "decl.in-out-initializer": { name: "n" },
  "pou.duplicate": { name: "Compute" },
  "pou.name-collision": { name: "TON" },
  "pou.program-count": { found: 0 },
  "pou.unsupported-kind": { name: "Block" },
  "pou.invalid-section": { section: "VAR_TEMP", kind: "function" },
  "pou.direct-address": {},
  "pou.function-block-in-function": {},
  "pou.recursion": { name: "Compute" },
  "call.program": { name: "Main" },
  "call.no-result": { name: "Compute" },
  "call.in-out-variable": {},
  "call.in-out-type": { from: "DINT", to: "INT" },
  "call.missing-in-out": { name: "Swap", parameter: "A" },
  "call.formal-required": { name: "Compute" },
  "name.undeclared": { name: "Missing" },
  "type.unknown-structure-member": { type: { kind: "named", name: "Point" }, member: "z" },
  "type.not-array": { type: "INT" },
  "type.array-index-count": { expected: 2, found: 1 },
  "type.array-index-not-integer": { type: "REAL" },
  "type.array-initializer-required": {
    type: { kind: "array", dimensions: [{ lower: 1, upper: 3 }], element: "INT" },
  },
  "type.invalid-bit-access": { type: "WORD", bit: 16 },
  "type.portability": { function: "DWORD_TO_REAL" },
  "type.invalid-constant": {},
  "type.case-label-not-constant": {},
  "fb.invalid-instance-section": { name: "Timer" },
  "fb.duplicate-input": { name: "Timer", member: "IN" },
  "type.assign-mismatch": { from: "REAL", to: "INT", hint: "explicit-conversion" },
  "type.operand-mismatch": { operator: "+", left: "BOOL", right: "INT" },
  "type.condition-not-bool": { statement: "WHILE" },
  "type.case-selector-not-integer": { type: "REAL" },
  "type.case-label-not-integer": { type: "BOOL" },
  "type.for-variable-not-integer": { name: "Index", type: "REAL" },
  "type.for-variable-subrange": { name: "p", type: { kind: "named", name: "Percent" } },
  "type.for-bound-not-integer": { bound: "step", type: "LREAL" },
  "flow.exit-outside-loop": {},
  "fb.not-function-block": { name: "Counter" },
  "fb.no-matching-variant": { name: "Counter", types: ["LINT", "ULINT"] },
  "fb.unknown-member": { name: "Timer", member: "MISSING" },
  "fb.output-not-writable": { name: "Timer", member: "Q" },
  "fb.instance-as-value": { name: "Timer" },
  "fb.unsupported-call": { name: "Timer" },
  "fb.call-in-expression": { name: "Timer" },
  "call.unknown-function": { name: "MISSING" },
  "call.invalid-parameter": { name: "SPLIT_DATE", parameter: "YEAR" },
  "call.argument-count": { name: "LIMIT", min: 3, max: 3, found: 2 },
  "call.argument-type": { name: "ABS", index: 0, expected: ["INT", "REAL"], found: "BOOL" },
  "runtime.index-out-of-range": { index: 6, lower: 1, upper: 5 },
  "runtime.subrange-violation": { value: 120, lower: 0, upper: 100 },
  "type.ambiguous-enumeration": { name: "Red" },
  "runtime.invalid-value": {},
  "runtime.division-by-zero": {},
  "runtime.watchdog": { limit: 10000 },
  "runtime.for-by-zero": {},
  "runtime.debug-target": {},
  "runtime.debug-type-mismatch": { from: "BOOL", to: "INT" },
  "runtime.debug-value": {},
  "runtime.write-input-mapped": { name: "input" },
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
        if (value === null || ["hint", "kind", "bound", "index", "form"].includes(key)) continue;
        for (const part of Array.isArray(value) ? value : [value]) {
          expect(message).toContain(
            typeof part === "object" ? formatType(part as TypeDescriptor) : String(part),
          );
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

  it.each([
    ["BYTE", "BOOL", "2"],
    ["WORD", "BOOL", "2"],
    ["DWORD", "BOOL", "2"],
    ["LWORD", "BOOL", "2"],
    ["REAL", "DWORD", "1.0"],
    ["DWORD", "REAL", "16#3F800000"],
    ["LREAL", "LWORD", "1.0"],
    ["LWORD", "LREAL", "16#3FF0000000000000"],
  ])("explains the vendor difference for TO_%s_%s in both languages", (from, to, literal) => {
    const compiled = compile(
      `PROGRAM P VAR result: ${to}; END_VAR result := TO_${to}(${from}#${literal}); END_PROGRAM`,
    );
    const diagnostic = compiled.diagnostics.find((item) => item.code === "type.portability");
    expect(diagnostic).toBeDefined();
    const english = formatDiagnostic("en", diagnostic!);
    const japanese = formatDiagnostic("ja", diagnostic!);
    for (const message of [english, japanese]) expect(message).toContain(`${from}_TO_${to}`);
    if (to === "BOOL") {
      expect(english).toContain("returns the rightmost bit");
      expect(english).toContain("return TRUE for any non-zero value");
      expect(japanese).toContain("最下位ビットを返します");
      expect(japanese).toContain("ゼロ以外のすべての値に対してTRUE");
    } else {
      expect(english).toContain("reinterprets the bit pattern");
      expect(english).toContain("convert the numeric value instead");
      expect(japanese).toContain("ビットパターンを再解釈します");
      expect(japanese).toContain("代わりに数値を変換します");
    }
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

it("describes NULL dereferencing as a runtime failure in Japanese", () => {
  expect(diagnosticJa["runtime.null-reference"]()).toBe("NULLを逆参照できません。");
});

it("explains type cycles in English and Japanese", () => {
  const diagnostic = {
    code: "decl.type-cycle",
    severity: "error",
    args: { name: "Node" },
  } as const;
  expect(formatDiagnostic("en", diagnostic)).toBe(
    "Type Node has a containment or alias cycle; use REF_TO for recursive links.",
  );
  expect(formatDiagnostic("ja", diagnostic)).toBe(
    "型Nodeの包含関係または別名定義が循環しています。再帰的なリンクにはREF_TOを使用してください。",
  );
});

it.each<[TypeDescriptor, string]>([
  [{ kind: "named", name: "Percent" }, "Percent"],
  [{ kind: "subrange", base: "INT", lower: 0, upper: 100 }, "INT (0..100)"],
])("explains the subrange FOR restriction for %j in both languages", (type, text) => {
  const diagnostic = {
    code: "type.for-variable-subrange",
    severity: "error",
    args: { name: "p", type },
  } as const;
  expect(formatDiagnostic("en", diagnostic)).toBe(
    `FOR variable p has subrange type ${text}, which is not supported as a loop control variable; use an unrestricted integer variable.`,
  );
  expect(formatDiagnostic("ja", diagnostic)).toBe(
    `FOR変数pの部分範囲型${text}はループ制御変数として使用できません。部分範囲のない整数変数を使用してください。`,
  );
});
