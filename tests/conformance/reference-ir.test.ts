import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SourceSpan } from "@benchtop-plc/core";
import { referenceIR } from "./fixtures/reference-ir.js";

const source = readFileSync(new URL("./fixtures/reference.st", import.meta.url), "utf8");
const lines = source.trimEnd().split("\n");

function sourceText(span: SourceSpan): string {
  const selected = lines.slice(span.line - 1, span.endLine);
  if (selected.length === 1) return selected[0]!.slice(span.column - 1, span.endColumn - 1);
  selected[0] = selected[0]!.slice(span.column - 1);
  selected[selected.length - 1] = selected[selected.length - 1]!.slice(0, span.endColumn - 1);
  return selected.join("\n");
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
  } else if (value !== null && typeof value === "object") {
    const node = value as Record<string, unknown>;
    visit(node);
    Object.values(node).forEach((child) => walk(child, visit));
  }
}

describe("hand-written reference program IR", () => {
  it("survives JSON and structured-clone transport unchanged", () => {
    expect(JSON.parse(JSON.stringify(referenceIR))).toStrictEqual(referenceIR);
    expect(structuredClone(referenceIR)).toStrictEqual(referenceIR);
    expect(referenceIR.variables).toHaveLength(11);
    expect(referenceIR.body).toHaveLength(8);
  });

  it("retains typed, resolved references and one-based source spans", () => {
    let nodeCount = 0;
    walk(referenceIR, (node) => {
      // IR nodes include branches and named call inputs as well as discriminated nodes.
      if (!("kind" in node || "condition" in node || "labels" in node || "input" in node)) return;
      nodeCount++;
      expect(node).toHaveProperty("span");
      const span = node.span as SourceSpan;
      expect(span.line).toBeGreaterThanOrEqual(1);
      expect(span.endLine).toBeGreaterThanOrEqual(span.line);
      expect(span.endLine).toBeLessThanOrEqual(lines.length);
      expect(span.column).toBeGreaterThanOrEqual(1);
      expect(span.column).toBeLessThanOrEqual(lines[span.line - 1]!.length + 1);
      expect(span.endColumn).toBeGreaterThanOrEqual(1);
      expect(span.endColumn).toBeLessThanOrEqual(lines[span.endLine - 1]!.length + 1);
      expect(sourceText(span)).not.toBe("");
      if (node.kind === "variable" || node.kind === "fbMember" || node.kind === "fbCall") {
        const declaration = referenceIR.variables[node.variable as number]!;
        expect(declaration).toBeDefined();
        expect(declaration.key).toBe(declaration.name.toUpperCase());
        if (node.kind === "variable") {
          expect(declaration.kind).toBe("scalar");
          if (declaration.kind === "scalar") expect(node.dataType).toBe(declaration.dataType);
          expect(sourceText(span)).toBe(declaration.name);
        } else {
          expect(declaration.kind).toBe("functionBlock");
          if (node.kind === "fbMember") {
            expect(node.port).toBe("output");
            expect(node.member).toBe(0);
            expect(node.dataType).toBe("BOOL");
            expect(sourceText(span)).toBe(`${declaration.name}.Q`);
          }
        }
      }
      if (node.kind === "scalar" || node.kind === "functionBlock") {
        expect(node.key).toBe(String(node.name).toUpperCase());
        expect(sourceText(span)).toMatch(/;$/);
      }
      if (node.kind === "literal") expect(sourceText(span)).toBe(String(node.value));
      if ("input" in node) {
        expect(sourceText(span).startsWith(String(node.name))).toBe(true);
        const value = node.value as { span: SourceSpan };
        expect(span.endColumn).toBeGreaterThanOrEqual(value.span.endColumn);
      }
    });
    expect(nodeCount).toBeGreaterThan(50);
  });
});
