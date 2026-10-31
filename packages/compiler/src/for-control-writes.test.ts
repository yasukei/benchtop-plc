import { expect, it } from "vitest";
import { compileProject } from "./index.js";

const declarations = "i, j, x : INT; r : REF_TO INT; counter : CTU; inst : Box;";
const program = (body: string) => `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
const helpers = [
  "FUNCTION Emit VAR_OUTPUT value : INT; END_VAR value := 1; END_FUNCTION",
  "FUNCTION Change VAR_IN_OUT value : INT; END_VAR value := value + 1; END_FUNCTION",
  `FUNCTION_BLOCK Box
   VAR_IN_OUT shared : INT; END_VAR VAR_OUTPUT value : INT; END_VAR
   METHOD PUBLIC Change VAR_IN_OUT arg : INT; END_VAR arg := arg + 1; END_METHOD
   METHOD PUBLIC Emit VAR_OUTPUT arg : INT; END_VAR arg := 1; END_METHOD
   END_FUNCTION_BLOCK`,
];

it.each([
  "«i» := i + 1;",
  "«I» := 0;",
  "FOR «i» := 1 TO 2 DO x := i; END_FOR;",
  "counter(CU := FALSE, R := FALSE, PV := 1, CV => «i»);",
  "Emit(value => «i»);",
  "inst(shared := x, value => «i»);",
  "inst.Emit(arg => «i»);",
  "Change(value := «i»);",
  "inst(shared := «i»);",
  "inst.Change(arg := «i»);",
  "r := REF(«i»);",
  "IF FALSE THEN «i» := 0; END_IF;",
  "CASE x OF 1: «i» := 0; END_CASE;",
  "WHILE FALSE DO «i» := 0; END_WHILE;",
  "REPEAT «i» := 0; UNTIL TRUE END_REPEAT;",
])("rejects an identifiable FOR control write at its target: %s", (body) => {
  const marked = program(`FOR i := 1 TO 3 DO ${body} END_FOR;`);
  const column = marked.indexOf("«") + 1;
  const name = marked.slice(column, marked.indexOf("»"));
  const result = compileProject([marked.replace(/[«»]/g, ""), ...helpers]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toEqual([
    {
      code: "flow.for-control-write",
      args: { name },
      severity: "error",
      pou: "Main",
      sourceIndex: 0,
      span: { line: 1, column, endLine: 1, endColumn: column + name.length },
    },
  ]);
});

it("reports every write and preserves outer protection after a reused nested control", () => {
  const result = compileProject([
    program(`FOR i := 1 TO 3 DO
      FOR i := 1 TO 2 DO i := 0; END_FOR;
      i := 0;
      FOR j := 1 TO 2 DO i := 0; j := 0; END_FOR;
      j := 0;
    END_FOR;
    i := 0;`),
    ...helpers,
  ]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map(({ code, args }) => ({ code, args }))).toEqual(
    ["i", "i", "i", "i", "j"].map((name) => ({
      code: "flow.for-control-write",
      args: { name },
    })),
  );
});

it.each([
  ["YEAR => i, MONTH => j", ["i", "j"]],
  ["YEAR => i, MONTH => i", ["i", "i"]],
] as const)("reports every standard function output write: %s", (outputs, names) => {
  const result = compileProject([
    program(`FOR i := 1 TO 3 DO FOR j := 1 TO 3 DO
      SPLIT_DATE(IN := D#2024-01-01, ${outputs});
    END_FOR; END_FOR;`),
    ...helpers,
  ]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toEqual(
    names.map((name) =>
      expect.objectContaining({ code: "flow.for-control-write", args: { name } }),
    ),
  );
});

it("allows reads, independent nested controls and writes after END_FOR", () => {
  const result = compileProject([
    program(`FOR i := 1 TO 3 DO
      x := i;
      FOR j := 1 TO i DO x := x + i + j; END_FOR;
      j := i;
      inst(shared := x); x := ABS(i);
    END_FOR;
    i := 0; Change(value := i); Emit(value => i); r := REF(i);
    FOR i := 1 TO 2 DO x := i; END_FOR;`),
    ...helpers,
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir).toBeDefined();
});

it.each(["THIS.i := 0;", "r := REF(THIS.i);"])(
  "recognizes the same control through THIS: %s",
  (body) => {
    const result = compileProject([
      "PROGRAM Main VAR inst : B; END_VAR inst(); END_PROGRAM",
      `FUNCTION_BLOCK B VAR i : INT; r : REF_TO INT; END_VAR
       FOR i := 1 TO 3 DO ${body} END_FOR; END_FUNCTION_BLOCK`,
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "flow.for-control-write", args: { name: "i" }, pou: "B" }),
    ]);
    expect(result.ir).toBeUndefined();
  },
);

it("rejects REF of an active temporary control with the control-write diagnostic", () => {
  const result = compileProject([
    "PROGRAM Main VAR_TEMP i : INT; END_VAR VAR r : REF_TO INT; END_VAR FOR i := 1 TO 3 DO r := REF(i); END_FOR; END_PROGRAM",
  ]);
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ code: "flow.for-control-write", args: { name: "i" } }),
  ]);
});
