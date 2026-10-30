import type { Project } from "@benchtop-plc/project";

export const nestingCases = [
  "parentheses",
  "unary",
  "binary",
  "calls",
  "if",
  "case",
  "for",
  "while",
  "repeat",
  "arrays",
  "initializers",
  "indices",
  "mixed",
] as const;

export function nestingSource(kind: (typeof nestingCases)[number], depth: number): string {
  let declarations = "x, i : DINT;";
  let body = "x := 1;";
  const arrayType = "ARRAY[0..0] OF ".repeat(depth) + "INT";
  const initial = "[".repeat(depth) + "1" + "]".repeat(depth);
  switch (kind) {
    case "parentheses":
      body = `x := ${"(".repeat(depth)}1${")".repeat(depth)};`;
      break;
    case "unary":
      body = `x := ${"+ ".repeat(depth)}1;`;
      break;
    case "binary":
      body = `x := 1${" + 0".repeat(depth)};`;
      break;
    case "calls":
      body = `x := ${"ABS(".repeat(depth)}1${")".repeat(depth)};`;
      break;
    case "if":
      body = "IF TRUE THEN ".repeat(depth) + body + " END_IF;".repeat(depth);
      break;
    case "case":
      body = "CASE 1 OF 1: ".repeat(depth) + body + " END_CASE;".repeat(depth);
      break;
    case "for":
      body = "FOR i := 1 TO 1 DO ".repeat(depth) + body + " END_FOR;".repeat(depth);
      break;
    case "while":
      body = "WHILE TRUE DO ".repeat(depth) + body + " EXIT; END_WHILE;".repeat(depth);
      break;
    case "repeat":
      body = "REPEAT ".repeat(depth) + body + " UNTIL TRUE END_REPEAT;".repeat(depth);
      break;
    case "arrays":
      declarations += ` a : ${arrayType};`;
      break;
    case "initializers":
      declarations += ` a : ${arrayType} := ${initial};`;
      break;
    case "indices":
      declarations += ` a : ${arrayType} := ${initial};`;
      body = `x := a${"[0]".repeat(depth)};`;
      break;
    case "mixed": {
      const statements = Math.floor(depth / 2);
      const expressions = depth - statements;
      body =
        "IF TRUE THEN ".repeat(statements) +
        `x := ${"(".repeat(expressions)}1${")".repeat(expressions)};` +
        " END_IF;".repeat(statements);
      break;
    }
  }
  return `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
}

export function nestingProject(source: string, dataTypes: string[] = []): Project {
  return {
    fileHeader: {
      companyName: "benchtop-plc",
      productName: "benchtop-plc",
      productVersion: "0.8.0",
      creationDateTime: "2026-10-31T00:00:00Z",
    },
    contentHeader: { name: "Nesting" },
    dataTypes,
    pous: [source],
    configuration: "Config",
    resource: "Res",
    task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
    instance: { name: "mainInstance", typeName: "Main" },
    panel: { width: 800, height: 600, widgets: [] },
  };
}
