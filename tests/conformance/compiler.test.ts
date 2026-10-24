import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import type { SourceSpan } from "@benchtop-plc/core";
import { referenceIR } from "./fixtures/reference-ir.js";

const source = readFileSync(new URL("./fixtures/reference.st", import.meta.url), "utf8");

function withoutSpans(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSpans);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "span")
        .map(([key, child]) => [key, withoutSpans(child)]),
    );
  return value;
}

describe("reference program compilation", () => {
  it("matches the checked-in JSON golden IR", () => {
    const result = compile(source);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir).toBeDefined();
    expect(result.ir).toEqual(
      JSON.parse(readFileSync(new URL("./fixtures/reference-ir.json", import.meta.url), "utf8")),
    );
    expect(result.ir!.variables).toStrictEqual(
      referenceIR.variables.map((variable) => ({
        ...variable,
        name: `mainInstance.${variable.name}`,
        key: `MAININSTANCE.${variable.key}`,
        path: ["mainInstance", variable.name],
        instance: "mainInstance",
      })),
    );
    // Independent hand-written semantics; compiled grouping spans include parentheses.
    expect(withoutSpans(result.ir!.programs[0]!.body)).toStrictEqual(
      withoutSpans(referenceIR.body),
    );
    expect(result.ir!.resource).toEqual({
      name: "Res",
      tasks: [{ name: "Cyclic", intervalMs: 10, priority: 1 }],
      programs: [
        {
          name: "mainInstance",
          program: 0,
          task: 0,
          storage: referenceIR.variables.map((_, variable) => ({ kind: "variable", variable })),
        },
      ],
    });
  });

  it("gives every IR node a nonempty source span contained in its parent", () => {
    const ir = compile(source).ir!;
    const lines = source.split("\n");
    const offset = (line: number, column: number) =>
      lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column - 1;
    let count = 0;
    function walk(value: unknown, parent?: SourceSpan): void {
      if (Array.isArray(value)) return value.forEach((child) => walk(child, parent));
      if (value === null || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if ("span" in node) {
        const span = node.span as SourceSpan;
        expect(span).toBeDefined();
        count++;
        expect(span.line).toBeGreaterThanOrEqual(1);
        expect(span.column).toBeGreaterThanOrEqual(1);
        expect(span.endLine).toBeLessThanOrEqual(lines.length);
        expect(span.column).toBeLessThanOrEqual(lines[span.line - 1]!.length + 1);
        expect(span.endColumn).toBeGreaterThanOrEqual(1);
        expect(span.endColumn).toBeLessThanOrEqual(lines[span.endLine - 1]!.length + 1);
        expect(offset(span.endLine, span.endColumn)).toBeGreaterThan(
          offset(span.line, span.column),
        );
        if (parent) {
          expect(offset(span.line, span.column)).toBeGreaterThanOrEqual(
            offset(parent.line, parent.column),
          );
          expect(offset(span.endLine, span.endColumn)).toBeLessThanOrEqual(
            offset(parent.endLine, parent.endColumn),
          );
        }
        parent = span;
      }
      for (const [key, child] of Object.entries(node)) if (key !== "span") walk(child, parent);
    }
    walk(ir);
    expect(count).toBeGreaterThan(50);
  });

  it("contains only JSON-compatible plain data and retains annotation locations", () => {
    const ir = compile(source).ir!;
    expect(JSON.parse(JSON.stringify(ir))).toStrictEqual(ir);
    expect(structuredClone(ir)).toStrictEqual(ir);
    const annotationLines: number[] = [];
    function walk(value: unknown): void {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value !== null && typeof value === "object") {
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        const node = value as Record<string, unknown>;
        if (node.kind === "assignment" || node.kind === "fbCall")
          annotationLines.push((node.span as SourceSpan).line);
        Object.values(node).forEach(walk);
      } else {
        expect(["string", "number", "boolean"].includes(typeof value) || value === null).toBe(true);
        if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
      }
    }
    walk(ir);
    expect(annotationLines).toEqual([17, 20, 21, 22, 25, 27, 31, 34]);
  });
});

describe("running-light program compilation", () => {
  it("matches the migrated running-light golden IR", () => {
    const source = readFileSync(new URL("./running-light/program.st", import.meta.url), "utf8");
    const result = compile(source);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir).toBeDefined();
    // Original body generated at ab9f9b9; migrated to the configuration storage model.
    expect(result.ir).toEqual(
      JSON.parse(
        readFileSync(new URL("./fixtures/running-light-ir.json", import.meta.url), "utf8"),
      ),
    );
  });
});
