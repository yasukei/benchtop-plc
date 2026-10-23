import { expect, it } from "vitest";
import { compileProject } from "./index.js";

const main = (declarations = "", body = "") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
const point = "TYPE Point : STRUCT x : INT; END_STRUCT; END_TYPE";

it.each(["FUNCTION", "FUNCTION_BLOCK"])("checks aggregate in-outs in a %s", (kind) => {
  const callee = kind === "FUNCTION" ? "F" : "inst";
  for (const [formal, actual, accepted] of [
    ["ARRAY[1..3] OF INT", "ARRAY[1..3] OF INT", true],
    ["ARRAY[1..3] OF INT", "ARRAY[0..2] OF INT", false],
    ["ARRAY[1..3] OF INT", "ARRAY[1..3] OF DINT", false],
    ["ARRAY[*] OF INT", "ARRAY[-2..2] OF INT", true],
    ["ARRAY[*] OF INT", "ARRAY[1..3] OF DINT", false],
    ["ARRAY[*] OF INT", "ARRAY[1..2,1..2] OF INT", false],
    ["ARRAY[*,*] OF INT", "ARRAY[-2..2,0..3] OF INT", true],
    ["ARRAY[1..3] OF STRING[20]", "ARRAY[1..3] OF STRING[10]", true],
    ["ARRAY[*] OF STRING[20]", "ARRAY[1..3] OF STRING[10]", true],
    ["ARRAY[*] OF INT", "ARRAY[1..3] OF INT (0..10)", false],
    ["INT", "INT (0..10)", false],
    ["Point", "OtherPoint", false],
    ["Point", "PointAlias", true],
  ] as const) {
    const compiled = compileProject(
      [
        main(
          `a : ${actual}; ${kind === "FUNCTION_BLOCK" ? "inst : F;" : ""}`,
          `${callee}(io := a);`,
        ),
        `${kind} F VAR_IN_OUT io : ${formal}; END_VAR END_${kind}`,
      ],
      [
        point,
        "TYPE OtherPoint : STRUCT x : INT; END_STRUCT; END_TYPE",
        "TYPE PointAlias : Point; END_TYPE",
      ],
    );
    if (accepted) expect(compiled.diagnostics, `${formal} <- ${actual}`).toEqual([]);
    else {
      expect(compiled.ir).toBeUndefined();
      expect(compiled.diagnostics).toContainEqual(
        expect.objectContaining({ code: "call.in-out-type" }),
      );
    }
  }
});

it.each([
  "FUNCTION F VAR_INPUT a : ARRAY[*] OF INT; END_VAR END_FUNCTION",
  "FUNCTION F VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR END_FUNCTION",
  "FUNCTION F VAR a : ARRAY[*] OF INT; END_VAR END_FUNCTION",
  "FUNCTION_BLOCK F VAR_TEMP a : ARRAY[*] OF INT; END_VAR END_FUNCTION_BLOCK",
  "FUNCTION F : ARRAY[*] OF INT END_FUNCTION",
  "FUNCTION F VAR_IN_OUT a : ARRAY[1..2] OF ARRAY[*] OF INT; END_VAR END_FUNCTION",
])("restricts open arrays: %s", (source) => {
  const compiled = compileProject([main(), source]);
  expect(compiled.ir).toBeUndefined();
  expect(compiled.diagnostics).toContainEqual(
    expect.objectContaining({ code: "decl.open-array-section" }),
  );
});

it.each(["ARRAY[*, 0..1] OF INT", "ARRAY[*,*,*,*] OF INT"])(
  "rejects invalid open dimensions %s",
  (type) => {
    const compiled = compileProject([
      main(),
      `FUNCTION F VAR_IN_OUT a : ${type}; END_VAR END_FUNCTION`,
    ]);
    expect(compiled.ir).toBeUndefined();
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.invalid-constant" }),
    );
  },
);

it("rejects open arrays in local variables and named data types", () => {
  for (const compiled of [
    compileProject([main("a : ARRAY[*] OF INT;")]),
    compileProject([main()], ["TYPE A : ARRAY[*] OF INT; END_TYPE"]),
  ]) {
    expect(compiled.ir).toBeUndefined();
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: "decl.open-array-section" }),
    );
  }
});

it("accepts elements and members as in-outs but rejects bit and FB port aliases", () => {
  for (const [actual, accepted] of [
    ["a[2]", true],
    ["p.x", true],
    ["a[2].3", false],
    ["inst.n", false],
  ] as const) {
    const compiled = compileProject(
      [
        main("a : ARRAY[1..3] OF INT; p : Point; inst : B;", `F(io := ${actual});`),
        "FUNCTION F VAR_IN_OUT io : INT; END_VAR END_FUNCTION",
        "FUNCTION_BLOCK B VAR_INPUT n : INT; END_VAR END_FUNCTION_BLOCK",
      ],
      [point],
    );
    if (accepted) expect(compiled.diagnostics).toEqual([]);
    else expect(compiled.ir).toBeUndefined();
  }
});

it.each([
  "LOWER_BOUND(a, 0)",
  "UPPER_BOUND(a, 3)",
  "LOWER_BOUND(a, i)",
  "LOWER_BOUND(a, 1.0)",
  "LOWER_BOUND(a)",
  "UPPER_BOUND(i, 1)",
  "LOWER_BOUND(IN := a, DIM := 1, Q => i)",
])("checks bounds query arguments: %s", (expression) => {
  const compiled = compileProject([
    main("a : ARRAY[1..2, -3..4] OF INT; i : DINT;", `i := ${expression};`),
  ]);
  expect(compiled.ir).toBeUndefined();
  expect(compiled.diagnostics.some((d) => d.severity === "error")).toBe(true);
});

it("checks aggregate input, output and result types", () => {
  const sources = [
    main("p : OtherPoint;", "p := F(p := p, q => p);"),
    "FUNCTION F : Point VAR_INPUT p : Point; END_VAR VAR_OUTPUT q : Point; END_VAR END_FUNCTION",
  ];
  const compiled = compileProject(sources, [
    point,
    "TYPE OtherPoint : STRUCT x : INT; END_STRUCT; END_TYPE",
  ]);
  expect(compiled.ir).toBeUndefined();
  expect(compiled.diagnostics.filter((d) => d.code === "type.assign-mismatch")).toHaveLength(3);
});

it("rejects nested open array function results and aliases of public port elements", () => {
  expect(
    compileProject([main(), "FUNCTION F : ARRAY[1..2] OF ARRAY[*] OF INT END_FUNCTION"])
      .diagnostics,
  ).toContainEqual(expect.objectContaining({ code: "decl.open-array-section" }));
  const result = compileProject([
    main("inst : Ports;", "F(io := inst.a[1]);"),
    "FUNCTION F VAR_IN_OUT io : INT; END_VAR END_FUNCTION",
    "FUNCTION_BLOCK Ports VAR_INPUT a : ARRAY[1..2] OF INT; END_VAR END_FUNCTION_BLOCK",
  ]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "call.in-out-variable" }),
  );
});
