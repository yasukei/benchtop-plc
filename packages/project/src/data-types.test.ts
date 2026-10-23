import { describe, expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { readProject, writeProject, SOURCE_NAMESPACE, type Project } from "./index.js";

const dataTypes = [
  "// exact spelling\r\ntype State : (Idle, Running, Done) := Running; end_type;\r\n",
  "TYPE Percent : INT (0..100) := 25; END_TYPE",
  "TYPE Speed : INT := 100; END_TYPE",
  "TYPE Ratio : Percent := 50; END_TYPE",
];
const pous = [
  "PROGRAM Main VAR currentState : State := State#Idle; p : Percent; inlineValue : INT (0..100) := 10; END_VAR currentState := Next(currentState); p := p + 1; END_PROGRAM",
  "FUNCTION Next : State VAR_INPUT s : State := Running; END_VAR VAR p : Percent := 40; END_VAR Next := State#Done; END_FUNCTION",
];
function project(types = dataTypes, sources = pous): Project {
  return {
    fileHeader: {
      companyName: "Test",
      productName: "Test",
      productVersion: "0.4.0",
      creationDateTime: "2026-10-23T00:00:00Z",
    },
    contentHeader: { name: "Data types" },
    dataTypes: types,
    pous: sources,
    configuration: "Config",
    resource: "Res",
    task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
    instance: { name: "mainInstance", typeName: "Main" },
    panel: null,
  };
}
function save(value = project()): string {
  const written = writeProject(value);
  expect(written.diagnostics).toEqual([]);
  expect(written.value).not.toBeNull();
  return written.value!;
}
function withoutSource(xml: string): string {
  return xml.replace(
    new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
    "",
  );
}
function executable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(executable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "span")
      .map(([key, item]) => [key, executable(item)]),
  );
}

describe("PLCopen data types", () => {
  it("preserves ordered exact type and POU texts and imports equivalent canonical IR", () => {
    const xml = save();
    expect(xml).toContain(
      '<dataType name="State"><baseType><enum><values><value name="Idle" value="0"/>',
    );
    expect(xml).toContain(
      '<subrangeSigned><range lower="0" upper="100"/><baseType><INT/></baseType></subrangeSigned>',
    );
    expect(readProject(xml)).toEqual({ value: project(), diagnostics: [] });
    const canonical = readProject(withoutSource(xml));
    expect(canonical.diagnostics).toEqual([]);
    const original = compileProject(pous, dataTypes);
    const imported = compileProject(canonical.value!.pous, canonical.value!.dataTypes);
    expect(original.diagnostics).toEqual([]);
    expect(imported.diagnostics).toEqual([]);
    expect(executable(imported.ir)).toEqual(executable(original.ir));
    expect(readProject(save(canonical.value!)).value).toEqual(canonical.value);
  });

  it.each([
    ["UINT", "0", "100", "Unsigned"],
    ["LINT", "-9223372036854775808", "9223372036854775807", "Signed"],
    ["ULINT", "0", "18446744073709551615", "Unsigned"],
  ])("preserves %s subranges without losing integer precision", (base, lower, upper, kind) => {
    const value = project(
      [`TYPE Limits : ${base} (${lower}..${upper}); END_TYPE`],
      [`PROGRAM Main VAR p : Limits; x : ${base} (${lower}..${upper}); END_VAR END_PROGRAM`],
    );
    const xml = save(value);
    expect(xml).toContain(`<subrange${kind}>`);
    expect(readProject(xml).value).toEqual(value);
    const canonical = readProject(withoutSource(xml)).value!;
    expect(executable(compileProject(canonical.pous, canonical.dataTypes).ir)).toEqual(
      executable(compileProject(value.pous, value.dataTypes).ir),
    );
  });

  it("folds expressions and earlier POU constants in anonymous bounds and function results", () => {
    const value = project(
      ["TYPE Small : INT (-2 - 1..2 + 1); END_TYPE"],
      [
        "PROGRAM Main VAR CONSTANT N : INT := 10; END_VAR VAR a,b : INT (0..N + 1); END_VAR END_PROGRAM",
        "FUNCTION F : INT (-1..1) F := 0; END_FUNCTION",
      ],
    );
    const xml = save(value);
    expect(xml).toContain('upper="11"');
    expect(readProject(xml).value).toEqual(value);
    const imported = readProject(withoutSource(xml)).value!;
    expect(compileProject(imported.pous, imported.dataTypes).diagnostics).toEqual([]);
    expect(executable(compileProject(imported.pous, imported.dataTypes).ir)).toEqual(
      executable(compileProject(value.pous, value.dataTypes).ir),
    );
  });

  it("preserves explicit enum bases, values, aliases and type defaults", () => {
    const value = project(
      [
        "TYPE Copy : Mode; END_TYPE",
        "TYPE Mode : UINT (Off := 0, Auto := 10, Manual := 20) := Mode#Auto; END_TYPE",
        "TYPE TimeAlias : TIME_OF_DAY := TOD#12:00:00; END_TYPE",
      ],
      ["PROGRAM Main VAR currentMode : Copy; END_VAR END_PROGRAM"],
    );
    const xml = save(value);
    expect(xml).toContain("<baseType><UINT/></baseType>");
    expect(readProject(xml).value).toEqual(value);
  });

  it.each([
    ["State", "1"],
    ["Percent", "101"],
    ["Ratio", "-1"],
    ["INT (0..100)", "101"],
  ])("rejects a variable initializer %s := %s on save and open", (type, initial) => {
    const valid = project(dataTypes, [`PROGRAM Main VAR x : ${type}; END_VAR END_PROGRAM`]);
    expect(
      writeProject({
        ...valid,
        pous: [valid.pous[0]!.replace(`${type};`, `${type} := ${initial};`)],
      }).value,
    ).toBeNull();
    const xml = save(valid).replace(
      "</type>",
      `</type><initialValue><simpleValue value="${initial}"/></initialValue>`,
    );
    expect(readProject(xml).value).toBeNull();
  });

  it.each([
    "TYPE State : (Idle, Running) := 1; END_TYPE",
    "TYPE Percent : INT (0..100) := 101; END_TYPE",
    "TYPE Small : INT := 40000; END_TYPE",
    "TYPE Copy : Percent := 101; END_TYPE",
  ])("rejects invalid data type defaults: %s", (source) => {
    const types = [dataTypes[1]!, source];
    expect(writeProject(project(types)).value).toBeNull();
    const xml = save().replace('value="25"', 'value="101"');
    expect(readProject(xml).value).toBeNull();
  });

  it("keeps unknown types and unresolved enum members as semantic errors", () => {
    const value = project(
      [
        "TYPE State : (Idle, Running) := State#Missing; END_TYPE",
        "TYPE AliasType : Unknown := 40000; END_TYPE",
      ],
      [
        "PROGRAM Main VAR currentState : State := State#Missing; unknown : MissingType := 40000; END_VAR END_PROGRAM",
      ],
    );
    expect(readProject(save(value)).value).toEqual(value);
    expect(readProject(withoutSource(save(value))).value).not.toBeNull();
  });

  it("replaces stale type source after an external base-type edit", () => {
    const xml = save().replace('name="Running" value="1"', 'name="Running" value="10"');
    const result = readProject(xml);
    expect(result.diagnostics).toEqual([
      { code: "project.stale-source", severity: "warning", args: {} },
    ]);
    expect(result.value!.dataTypes[0]).toContain("Running := 10");
    expect(result.value!.dataTypes.slice(1)).toEqual(dataTypes.slice(1));
  });

  it.each([
    "<array/>",
    "<struct/>",
    "<pointer/>",
    '<string length="20" encoding="UTF-8"/>',
    '<wstring length="20" encoding="UTF-8"/>',
  ])("rejects unsupported TC6 types %s", (type) => {
    const xml = save(project(["TYPE T : INT; END_TYPE"])).replace(
      '<dataType name="T"><baseType><INT/>',
      `<dataType name="T"><baseType>${type}`,
    );
    expect(readProject(xml).diagnostics).toContainEqual(
      expect.objectContaining({
        code: type === "<array/>" ? "project.invalid" : "project.unsupported",
      }),
    );
  });
});

it("imports TC6 enum values without explicit numbers or an explicit base", () => {
  const value = project(
    ["TYPE State : (Idle, Running, Done); END_TYPE"],
    ["PROGRAM Main VAR s : State := Running; END_VAR END_PROGRAM"],
  );
  const xml = withoutSource(save(value))
    .replace(/ value="[012]"/g, "")
    .replace("</values><baseType><INT/></baseType>", "</values>");
  const imported = readProject(xml);
  expect(imported.diagnostics).toEqual([]);
  expect(compileProject(imported.value!.pous, imported.value!.dataTypes).diagnostics).toEqual([]);
  expect(executable(compileProject(imported.value!.pous, imported.value!.dataTypes).ir)).toEqual(
    executable(compileProject(value.pous, value.dataTypes).ir),
  );
});

it.each([
  "TYPE State : (Idle := 0, Running := 40000); END_TYPE",
  "TYPE State : (Idle, Idle); END_TYPE",
  "TYPE Percent : INT (10..0); END_TYPE",
])("diagnoses unrepresentable definitions instead of losing values: %s", (source) => {
  expect(writeProject(project([source])).value).toBeNull();
});

it("does not let unrelated semantic errors hide an invalid initializer", () => {
  const types = ["TYPE State : (Idle, Running); END_TYPE", "TYPE Missing : Unknown; END_TYPE"];
  const value = project(types, [
    "PROGRAM Main VAR missing : Unknown; s : State := 1; END_VAR END_PROGRAM",
  ]);
  expect(writeProject(value).value).toBeNull();
  expect(
    writeProject(project(["TYPE T : INT := 1; END_TYPE", "TYPE T : INT := 40000; END_TYPE"])).value,
  ).toBeNull();
});

it("warns about malformed preserved type text while keeping the standard definition", () => {
  const xml = save().replace(
    "type State : (Idle, Running, Done) := Running; end_type;",
    "type State : ; end_type;",
  );
  const imported = readProject(xml);
  expect(imported.diagnostics).toContainEqual({
    code: "project.stale-source",
    severity: "warning",
    args: {},
  });
  expect(imported.value!.dataTypes[0]).toContain("Idle := 0");
});

it("rejects declaration text injected through a derived name", () => {
  const xml = save(project(["TYPE AliasType : Unknown; END_TYPE"])).replace(
    'name="UNKNOWN"',
    'name="INT := 123"',
  );
  expect(readProject(xml).value).toBeNull();
});

it("does not reserve synthetic checker names in user source", () => {
  const value = project(
    ["TYPE __RANGE_ : INT; END_TYPE"],
    [
      "PROGRAM Main VAR CONSTANT __RANGE : INT := 10; END_VAR VAR x : INT (0..__RANGE); END_VAR END_PROGRAM",
    ],
  );
  expect(readProject(save(value)).value).toEqual(value);
});

it.each(["unknown : MissingType", "n : INT := missing"])(
  "keeps unrelated unresolved constants exchangeable alongside inline ranges: %s",
  (declaration) => {
    const value = project(
      [],
      [
        `PROGRAM Main VAR CONSTANT ${declaration}; END_VAR VAR x : INT (0..10); END_VAR END_PROGRAM`,
      ],
    );
    const xml = save(value);
    expect(readProject(xml).value).toEqual(value);
    expect(readProject(withoutSource(xml)).value).not.toBeNull();
  },
);

it("folds transitive constant dependencies while ignoring unrelated unresolved declarations", () => {
  const value = project(
    [],
    [
      "PROGRAM Main VAR CONSTANT unknown : MissingType; N : INT := 10; M : INT := N + 1; END_VAR VAR x : INT (0..M + 1); END_VAR END_PROGRAM",
    ],
  );
  const xml = save(value);
  expect(xml).toContain('upper="12"');
  expect(readProject(xml).value).toEqual(value);
});

it("round-trips string capacities, character conventions, constants and POU interfaces", () => {
  const value = project(
    [
      "TYPE Message : STRING[20] := 'Ready'; END_TYPE",
      "TYPE WideMessage : WSTRING; END_TYPE",
      "TYPE Code : CHAR := 'X'; END_TYPE",
    ],
    [
      `PROGRAM Main VAR s : STRING[20] := '(* // $'quoted$')'; wide : WSTRING := "$00C4"; ch : CHAR; wch : WCHAR; alias : Message; END_VAR END_PROGRAM`,
      `FUNCTION Echo : STRING[20] VAR_INPUT s : STRING[20]; END_VAR VAR_OUTPUT result : WSTRING; END_VAR VAR_IN_OUT codeValue : CHAR; END_VAR Echo := s; END_FUNCTION`,
    ],
  );
  const xml = save(value);
  expect(xml).toContain('<string length="20"/>');
  expect(xml).toContain("<wstring/>");
  expect(xml).toContain('<derived name="CHAR"/>');
  expect(xml).toContain('<derived name="WCHAR"/>');
  expect(readProject(xml)).toEqual({ value, diagnostics: [] });
  const canonical = readProject(withoutSource(xml));
  expect(canonical.diagnostics).toEqual([]);
  const compiled = compileProject(value.pous, value.dataTypes);
  expect(compiled.diagnostics).toEqual([]);
  expect(executable(compileProject(canonical.value!.pous, canonical.value!.dataTypes).ir)).toEqual(
    executable(compiled.ir),
  );
});

it.each(["0", "1025", "-1", "1.5", "x"])("rejects an invalid XML string length %s", (length) => {
  const xml = save(project(["TYPE T : INT; END_TYPE"])).replace(
    '<dataType name="T"><baseType><INT/>',
    `<dataType name="T"><baseType><string length="${length}"/>`,
  );
  expect(readProject(xml).value).toBeNull();
});

it.each(["STRING[0]", "WSTRING[1025]", "CHAR[2]"])(
  "rejects invalid string source capacity %s on export",
  (type) => {
    expect(
      writeProject(project([], [`PROGRAM Main VAR text : ${type}; END_VAR END_PROGRAM`])).value,
    ).toBeNull();
    expect(
      writeProject(project([`TYPE Text : ${type}; END_TYPE`], ["PROGRAM Main END_PROGRAM"])).value,
    ).toBeNull();
  },
);

it("round trips named, anonymous and nested arrays, row-major initializers and repetitions", () => {
  const value = project(
    [
      "TYPE Table : ARRAY[1..3] OF INT := [1, 2, 1(3)]; END_TYPE",
      "TYPE Nested : ARRAY[1..2] OF ARRAY[-1..1] OF STRING[5] := [2(['a', 'b'])]; END_TYPE",
    ],
    [
      "PROGRAM Main VAR CONSTANT N : INT := 3; END_VAR VAR a : Table; b : ARRAY[0..1,1..N] OF INT := [2(1, 2), 2(0)]; grid : Nested; END_VAR a[2] := b[1,1]; END_PROGRAM",
    ],
  );
  const xml = save(value);
  expect(xml).toContain('<array><dimension lower="0" upper="1"/><dimension lower="1" upper="3"/>');
  expect(xml).toContain('<value repetitionValue="2"><simpleValue value="0"/>');
  expect(xml).toContain("<arrayValue>");
  expect(readProject(xml)).toEqual({ value, diagnostics: [] });
  const canonical = readProject(withoutSource(xml));
  expect(canonical.diagnostics).toEqual([]);
  const compiled = compileProject(canonical.value!.pous, canonical.value!.dataTypes);
  expect(compiled.diagnostics).toEqual([]);
  expect(executable(compiled.ir)).toEqual(
    executable(compileProject(value.pous, value.dataTypes).ir),
  );
});

it.each([
  "<array/>",
  '<array><dimension lower="0" upper="2147483648"/><baseType><INT/></baseType></array>',
  '<array><dimension lower="5" upper="1"/><baseType><INT/></baseType></array>',
])("rejects malformed array types %s", (type) => {
  const xml = save(project(["TYPE T : INT; END_TYPE"])).replace(
    '<dataType name="T"><baseType><INT/>',
    `<dataType name="T"><baseType>${type}`,
  );
  expect(readProject(xml).value).toBeNull();
});

it("folds repetition counts from POU constants and any integer type", () => {
  const value = project(
    [],
    [
      "PROGRAM Main VAR CONSTANT N : ULINT := ULINT#2; END_VAR VAR a : ARRAY[1..5] OF INT := [N(1,2), ULINT#1(0)]; END_VAR END_PROGRAM",
    ],
  );
  expect(readProject(save(value))).toEqual({ value, diagnostics: [] });
});

it("preserves arrays with unresolved element types and unresolved leaf initializers", () => {
  const value = project(
    ["TYPE Table : ARRAY[1..2] OF Missing := [UnknownValue]; END_TYPE"],
    [
      "PROGRAM Main VAR a : ARRAY[1..2] OF Missing := [UnknownValue]; b : ARRAY[1..2] OF INT := [UnknownValue]; END_VAR END_PROGRAM",
    ],
  );
  expect(readProject(save(value))).toEqual({ value, diagnostics: [] });
});

it.each(["[-1(0)]", "[N(0)]", "[2.5(0)]", "[[1](0)]"])(
  "rejects invalid array repetitions %s without throwing",
  (initial) => {
    expect(
      writeProject(
        project([], [`PROGRAM Main VAR a : ARRAY[1..5] OF INT := ${initial}; END_VAR END_PROGRAM`]),
      ).value,
    ).toBeNull();
  },
);
