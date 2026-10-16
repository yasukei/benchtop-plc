import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SourceSpan } from "@benchtop-plc/core";
import { parse } from "@benchtop-plc/compiler";

const source = readFileSync(new URL("./fixtures/reference.st", import.meta.url), "utf8");

describe("reference ST parser", () => {
  it("parses the parent issue's program without diagnostics", () => {
    const { ast, diagnostics } = parse(source);
    expect(diagnostics).toEqual([]);
    expect(ast).toMatchObject({ kind: "program", name: { name: "Main", key: "MAIN" } });
    expect(ast?.declarations).toHaveLength(11);
    expect(ast?.body.map(({ kind }) => kind)).toEqual([
      "assignment",
      "fbCall",
      "fbCall",
      "assignment",
      "fbCall",
      "if",
      "if",
      "assignment",
    ]);
    expect(JSON.parse(JSON.stringify(ast))).toStrictEqual(ast);
    expect(structuredClone(ast)).toStrictEqual(ast);
  });

  it("gives every AST node a nonempty span contained in its parent's span", () => {
    const { ast } = parse(source);
    const lines = source.split("\n");
    let nodeCount = 0;
    function position(line: number, column: number): number {
      return lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column - 1;
    }
    function walk(value: unknown, parent?: SourceSpan): void {
      if (Array.isArray(value)) return value.forEach((child) => walk(child, parent));
      if (value === null || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      const span = node.span as SourceSpan;
      expect(span).toBeDefined();
      nodeCount++;
      const start = position(span.line, span.column);
      const end = position(span.endLine, span.endColumn);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(source.length);
      expect(end).toBeGreaterThan(start);
      if (parent) {
        expect(start).toBeGreaterThanOrEqual(position(parent.line, parent.column));
        expect(end).toBeLessThanOrEqual(position(parent.endLine, parent.endColumn));
      }
      if (typeof node.name === "string") expect(source.slice(start, end)).toBe(node.name);
      if (node.kind === "literal") expect(source.slice(start, end)).toBe(node.text);
      for (const [key, child] of Object.entries(node)) if (key !== "span") walk(child, span);
    }
    walk(ast);
    expect(nodeCount).toBeGreaterThan(100);
  });
});
