import { expect, it } from "vitest";
import { compileProject, parsePou } from "./index.js";

const main = (body = "", vars = "c: Counter; x: INT;") =>
  `PROGRAM Main VAR ${vars} END_VAR ${body} END_PROGRAM`;
const block = (methods: string, vars = "VAR n: INT; END_VAR", body = "") =>
  `FUNCTION_BLOCK Counter ${vars} ${methods} ${body} END_FUNCTION_BLOCK`;

it("shares method definitions and resolves formal, positional and THIS calls", () => {
  const result = compileProject([
    main("c.Add(2); x := c.Value();"),
    block(
      `
    METHOD PUBLIC Add VAR_INPUT A: INT; END_VAR THIS.n := n + A; END_METHOD
    METHOD PUBLIC Value : INT Value := n; END_METHOD
    METHOD Reset n := 0; END_METHOD`,
      undefined,
      "Reset(); THIS.Add(A := 1);",
    ),
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.functionBlocks?.[0]?.methods).toHaveLength(3);
  expect(JSON.parse(JSON.stringify(result.ir))).toEqual(result.ir);
});

it.each([
  ["METHOD M END_METHOD METHOD m END_METHOD", "method.name-collision"],
  ["METHOD n END_METHOD", "method.name-collision"],
  ["METHOD M VAR n: INT; END_VAR END_METHOD", "method.name-collision"],
  ["METHOD M VAR M: INT; END_VAR END_METHOD", "method.name-collision"],
  ["METHOD M VAR_TEMP t: INT; END_VAR END_METHOD", "pou.invalid-section"],
  ["METHOD M VAR_EXTERNAL g: INT; END_VAR END_METHOD", "pou.invalid-section"],
  ["METHOD M VAR RETAIN t: INT; END_VAR END_METHOD", "decl.retention-function"],
  ["METHOD M VAR NON_RETAIN t: INT; END_VAR END_METHOD", "decl.retention-function"],
  ["METHOD M VAR other: Counter; END_VAR END_METHOD", "pou.function-block-in-function"],
  ["METHOD M M(); END_METHOD", "pou.recursion"],
  ["METHOD M THIS.M(); END_METHOD", "pou.recursion"],
  ["METHOD M Next(); END_METHOD METHOD Next M(); END_METHOD", "pou.recursion"],
  ["METHOD M THIS(); END_METHOD", "method.this-call"],
])("rejects invalid method declarations: %s", (methods, code) => {
  const result = compileProject([main(), block(methods)]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((d) => d.code)).toContain(code);
});

it.each(["PRIVATE", "PROTECTED", ""])("checks %s method access", (access) => {
  const result = compileProject([main("c.M();"), block(`METHOD ${access} M END_METHOD`)]);
  expect(result.diagnostics.map((d) => d.code)).toContain("access.hidden");
});

it.each(["PUBLIC", "INTERNAL"])("allows %s methods and members", (access) => {
  expect(
    compileProject([
      main("c.M(); c.n := 3; x := c.n;"),
      block(`METHOD ${access} M END_METHOD`, `VAR ${access} n: INT; END_VAR`),
    ]).diagnostics,
  ).toEqual([]);
});

it.each([
  [main("c.Missing();"), block(""), "method.unknown"],
  [main("x := c.M();"), block("METHOD PUBLIC M END_METHOD"), "call.no-result"],
  [main("x := c.M();"), block("METHOD PUBLIC M : BOOL END_METHOD"), "type.assign-mismatch"],
  [main("x := THIS.n;"), block(""), "method.this-outside"],
  [main("c.n := 1;"), block(""), "fb.unknown-member"],
  [
    main(),
    block("METHOD M n := p; END_METHOD", "VAR_IN_OUT p: INT; END_VAR VAR n: INT; END_VAR"),
    "method.instance-in-out",
  ],
])("reports call and member errors", (source, fb, code) => {
  const result = compileProject([source, fb]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((d) => d.code)).toContain(code);
});

it.each([
  "PROGRAM Main METHOD M END_METHOD END_PROGRAM",
  "FUNCTION F METHOD M END_METHOD END_FUNCTION",
])("rejects methods outside blocks", (source) => {
  expect(parsePou(source).diagnostics[0]?.code).toBe("method.invalid-owner");
});

it.each([
  ["VAR_INPUT PUBLIC n: INT; END_VAR", "access.invalid-section"],
  ["VAR PUBLIC PRIVATE n: INT; END_VAR", "access.duplicate"],
  ["METHOD PUBLIC PRIVATE M END_METHOD", "access.duplicate"],
])("rejects invalid access qualifiers", (text, code) => {
  expect(parsePou(block(text, "")).diagnostics[0]?.code).toBe(code);
});

it("keeps THIS limited to members and excludes instance temporaries from methods", () => {
  const local = compileProject([
    main(),
    block("METHOD M VAR t: INT; END_VAR THIS.t := 1; END_METHOD"),
  ]);
  expect(local.diagnostics.map((d) => d.code)).toContain("fb.unknown-member");
  const temp = compileProject([
    main(),
    block("METHOD M t := 1; END_METHOD", "VAR_TEMP t: INT; END_VAR"),
  ]);
  expect(temp.diagnostics.map((d) => d.code)).toContain("name.undeclared");
});

it("checks private access by type across different instances", () => {
  const configuration = `CONFIGURATION C VAR_GLOBAL a,b: Counter; END_VAR RESOURCE R ON Cpu
  TASK T (INTERVAL := T#10ms, PRIORITY := 0); PROGRAM P WITH T : Main; END_RESOURCE END_CONFIGURATION`;
  const result = compileProject(
    [
      main(),
      block(
        `METHOD PUBLIC ReadOther : INT ReadOther := b.Hidden(); END_METHOD
  METHOD PRIVATE Hidden : INT Hidden := b.n; END_METHOD`,
        "VAR_EXTERNAL b: Counter; END_VAR VAR PRIVATE n: INT; END_VAR",
      ),
    ],
    [],
    configuration,
  );
  expect(result.diagnostics).toEqual([]);
});

it("rejects cycles through function block bodies", () => {
  const result = compileProject(
    [main(), block("METHOD M other(); END_METHOD", "VAR_EXTERNAL other: Counter; END_VAR", "M();")],
    [],
    `CONFIGURATION Config VAR_GLOBAL other: Counter; END_VAR RESOURCE R ON Cpu
  TASK T (INTERVAL := T#10ms, PRIORITY := 0); PROGRAM P WITH T : Main; END_RESOURCE END_CONFIGURATION`,
  );
  expect(result.diagnostics.map((d) => d.code)).toContain("pou.recursion");
  expect(
    compileProject([main(), block("METHOD M END_METHOD", undefined, "M();")]).diagnostics,
  ).toEqual([]);
});

it("selects overloaded blocks through THIS-qualified port assignments", () => {
  const result = compileProject([
    main(),
    block(
      `METHOD PUBLIC Run THIS.timer.PT := LTIME#1s; timer(IN := TRUE); END_METHOD`,
      "VAR timer: TON; END_VAR",
    ),
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.functionBlocks?.[0]?.variables[0]).toMatchObject({ fbType: "TON_LTIME" });
});

it("does not infer an unrelated block variant from a qualified method name", () => {
  const result = compileProject([
    main(),
    block(
      `METHOD PUBLIC Run child.timer(PT := LTIME#1s); END_METHOD
  METHOD PUBLIC Elapsed : TIME Elapsed := timer.ET; END_METHOD`,
      "VAR timer: TON; child: Inner; END_VAR",
    ),
    "FUNCTION_BLOCK Inner METHOD PUBLIC timer VAR_INPUT PT: LTIME; END_VAR END_METHOD END_FUNCTION_BLOCK",
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.functionBlocks?.[0]?.variables[0]).toMatchObject({ fbType: "TON" });
});
