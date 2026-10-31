import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const documentation = read("docs/diagnostics.md");
const source = ts.createSourceFile(
  "diagnostic.ts",
  read("packages/core/src/diagnostic.ts"),
  ts.ScriptTarget.Latest,
);
const contract = source.statements.find(
  (node): node is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(node) && node.name.text === "DiagnosticArgs",
);
if (!contract) throw new Error("DiagnosticArgs interface not found");
const codes = contract.members.map((member) => {
  if (!ts.isPropertySignature(member) || !ts.isStringLiteral(member.name)) {
    throw new Error("Expected a diagnostic code property in DiagnosticArgs");
  }
  return member.name.text;
});

function documentationDifferences(markdown: string, expected: string[]) {
  // Definitions start a table row or prose line; inline examples such as inst.io are not codes.
  const documented = new Set(
    Array.from(markdown.matchAll(/^(?:\|\s*)?`([a-z]+\.[a-z][a-z0-9-]*)`/gm), (match) => match[1]!),
  );
  const known = new Set(expected);
  return {
    missing: expected.filter((code) => !documented.has(code)).sort(),
    obsolete: [...documented].filter((code) => !known.has(code)).sort(),
  };
}

describe("diagnostics documentation", () => {
  it("documents exactly the codes in DiagnosticArgs", () => {
    expect(codes.length).toBeGreaterThan(0);
    expect(documentationDifferences(documentation, codes)).toEqual({ missing: [], obsolete: [] });
  });

  it("reports a missing code by name", () => {
    const markdown = "| `runtime.watchdog` | Loop iteration limit exceeded | `{ limit: number }` |";
    expect(documentationDifferences(markdown, ["runtime.watchdog", "name.undeclared"])).toEqual({
      missing: ["name.undeclared"],
      obsolete: [],
    });
  });

  it("recognizes codes in prose as well as tables", () => {
    expect(
      documentationDifferences("`runtime.index-out-of-range` reports an invalid index.", [
        "runtime.index-out-of-range",
      ]),
    ).toEqual({ missing: [], obsolete: [] });
  });

  it("does not treat a dotted variable example as a diagnostic code", () => {
    expect(documentationDifferences("External reads of `inst.io` report an error.", [])).toEqual({
      missing: [],
      obsolete: [],
    });
  });

  it("reports a documented code that no longer exists", () => {
    const markdown = "| `runtime.removed-code` | Obsolete meaning | `{}` |";
    expect(documentationDifferences(markdown, [])).toEqual({
      missing: [],
      obsolete: ["runtime.removed-code"],
    });
  });
});
