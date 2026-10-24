import { compileProject } from "@benchtop-plc/compiler";
import { describe, expect, it } from "vitest";
import { readProject, SOURCE_NAMESPACE, writeProject } from "./index.js";
function sampleProject(): import("./model.js").Project {
  return {
    fileHeader: {
      companyName: "Test",
      productName: "Test",
      productVersion: "0.5.0",
      creationDateTime: "2026-10-24T00:00:00Z",
    },
    contentHeader: { name: "Test" },
    dataTypes: [],
    pous: ["PROGRAM Main END_PROGRAM"],
    configuration: "Config",
    resource: "Res",
    task: { name: "Cyclic", interval: "PT0.01S", priority: 0 },
    panel: null,
  };
}

const source = `// preserve declarations and CRLF\r
configuration Plant\r
RESOURCE Station ON Cpu\r
TASK Fast (INTERVAL := T#10ms, PRIORITY := 0);\r
TASK Slow (INTERVAL := T#100ms, PRIORITY := 2);\r
PROGRAM A WITH Fast : Main;\r
PROGRAM B WITH Slow : Main;\r
PROGRAM C WITH Fast : Main;\r
END_RESOURCE\r
end_configuration\r
`;
function save(configurationSource = source): string {
  const result = writeProject({ ...sampleProject(), configurationSource });
  expect(result.diagnostics).toEqual([]);
  expect(result.value).not.toBeNull();
  return result.value!;
}
function withoutSource(xml: string): string {
  return xml.replace(
    new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
    "",
  );
}

describe("configuration exchange", () => {
  it("preserves exact source with two tasks and three instances in the standard structure", () => {
    const xml = save();
    expect(xml).toContain(
      '<task name="Fast" interval="PT0.01S" priority="0"><pouInstance name="A" typeName="Main"/><pouInstance name="C" typeName="Main"/></task>',
    );
    expect(xml).toContain(
      '<task name="Slow" interval="PT0.1S" priority="2"><pouInstance name="B" typeName="Main"/></task>',
    );
    const opened = readProject(xml);
    expect(opened.diagnostics).toEqual([]);
    expect(opened.value?.configurationSource).toBe(source);
    expect(readProject(writeProject(opened.value!).value!).value?.configurationSource).toBe(source);
    expect(
      compileProject(opened.value!.pous, [], opened.value!.configurationSource).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: "config.task-count" }));
  });

  it("generates source for several tasks or several instances without an extension", () => {
    for (const configuration of [
      source,
      source.replace(/TASK Slow[^;]*;/, "").replace("WITH Slow", "WITH Fast"),
    ]) {
      const opened = readProject(withoutSource(save(configuration)));
      expect(opened.diagnostics).toEqual([]);
      expect(opened.value?.configurationSource).toContain("RESOURCE Station ON BENCHTOP");
      expect(opened.value?.configurationSource).toContain("PROGRAM C WITH Fast : Main;");
      expect(readProject(writeProject(opened.value!).value!)).toEqual(opened);
    }
  });

  it.each(["%IX0.1", "gAck"])("imports and saves a single event task triggered by %s", (single) => {
    const xml = withoutSource(writeProject(sampleProject()).value!).replace(
      'name="Cyclic" interval="PT0.01S"',
      `name="OnAck" single="${single}"`,
    );
    const opened = readProject(xml);
    expect(opened.diagnostics).toEqual([]);
    expect(opened.value?.configurationSource).toContain(
      `TASK OnAck (SINGLE := ${single}, PRIORITY := 0);`,
    );
    expect(readProject(writeProject(opened.value!).value!)).toEqual(opened);
  });

  it.each([
    ['name="Fast" interval="PT0.01S"', 'name="Quick" interval="PT0.01S"'],
    ['interval="PT0.01S"', 'interval="PT0.02S"'],
    ['priority="2"', 'priority="3"'],
    ['name="B" typeName="Main"', 'name="Renamed" typeName="Main"'],
    ['name="B" typeName="Main"', 'name="B" typeName="Unknown"'],
  ])("rebuilds stale source after standard XML changes: %s", (before, after) => {
    const result = readProject(save().replace(before, after));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "project.stale-source" }),
    );
    expect(result.value?.configurationSource).not.toBe(source);
    expect(writeProject(result.value!).value).not.toBeNull();
  });

  it("does not treat equivalent ISO durations as stale", () => {
    expect(
      readProject(save().replace('interval="PT0.1S"', 'interval="PT0H0M0.100S"')).diagnostics,
    ).toEqual([]);
  });

  it.each([
    ["missing task", "PROGRAM A WITH Missing : Main;"],
    ["missing type", "PROGRAM A WITH Fast : Unknown;"],
    ["missing WITH", "PROGRAM A : Main;"],
    ["duplicate instance", "PROGRAM A WITH Fast : Main; PROGRAM A WITH Fast : Main;"],
  ])("preserves semantic errors for compilation: %s", (_, instance) => {
    const text = `CONFIGURATION Plant RESOURCE Station ON Cpu TASK Fast (INTERVAL := T#10ms, PRIORITY := 0); ${instance} END_RESOURCE END_CONFIGURATION`;
    const opened = readProject(save(text));
    expect(opened.diagnostics).toEqual([]);
    expect(opened.value?.configurationSource).toBe(text);
    expect(compileProject(opened.value!.pous, [], text).ir).toBeUndefined();
  });

  it.each(["T#15ms", "T#2h", "LT#20ms", "LT#1500us7ns", "LT#100d"])(
    "preserves representable interval %s for compilation",
    (literal) => {
      const text = source.replace("T#10ms", literal);
      expect(readProject(save(text)).value?.configurationSource).toBe(text);
    },
  );

  it.each([
    ["T#10.5ms", "PT0.0105S"],
    ["TIME#0.0105s", "PT0.0105S"],
    ["T#+0.010_5s", "PT0.0105S"],
    ["T#1s10.5ms", "PT1.0105S"],
    ["T#0.5ms", "PT0.0005S"],
    ["LT#10.5ms", "PT0.0105S"],
  ])("keeps the exact interval and compile error for %s", (literal, duration) => {
    const text = `CONFIGURATION Plant RESOURCE Station ON Cpu
TASK Fast (INTERVAL := ${literal}, PRIORITY := 0);
PROGRAM A WITH Fast : Main; PROGRAM B WITH Fast : Main;
END_RESOURCE END_CONFIGURATION`;
    const xml = save(text);
    expect(xml).toContain(`interval="${duration}"`);
    const preserved = readProject(xml);
    expect(preserved.diagnostics).toEqual([]);
    expect(preserved.value?.configurationSource).toBe(text);
    for (const input of [xml, withoutSource(xml)]) {
      const opened = readProject(input);
      expect(opened.diagnostics).toEqual([]);
      expect(
        compileProject(opened.value!.pous, [], opened.value!.configurationSource).diagnostics,
      ).toContainEqual(expect.objectContaining({ code: "config.interval" }));
      expect(readProject(writeProject(opened.value!).value!)).toEqual(opened);
    }
    const edited = readProject(xml.replace(`interval="${duration}"`, 'interval="PT0.01S"'));
    expect(edited.diagnostics).toContainEqual(
      expect.objectContaining({ code: "project.stale-source" }),
    );
    expect(
      compileProject(edited.value!.pous, [], edited.value!.configurationSource).diagnostics,
    ).toEqual([]);
  });

  it.each(["INT#0", "DINT#0", "UDINT#0", "BYTE#0", "LINT#65535", "16#FF"])(
    "preserves compiler-valid priority %s",
    (literal) => {
      const text = source.replace("PRIORITY := 0", `PRIORITY := ${literal}`);
      expect(readProject(save(text)).value?.configurationSource).toBe(text);
    },
  );

  it("reconstructs precise and long LTIME intervals without a source extension", () => {
    for (const literal of ["LT#1500us7ns", "LT#100d"]) {
      const opened = readProject(withoutSource(save(source.replace("T#10ms", literal))));
      expect(opened.diagnostics).toEqual([]);
      expect(readProject(writeProject(opened.value!).value!)).toEqual(opened);
    }
  });

  it.each([
    source.replace("T#10ms", "T#30d"),
    source.replace("T#10ms", "LT#0.5ns"),
    source.replace("PRIORITY := 0", "PRIORITY := 65536"),
    source.replace("PRIORITY := 0", "PRIORITY := TRUE"),
    source.replace("PRIORITY := 0", "PRIORITY := 0,"),
    source.replace("END_RESOURCE", "VAR_GLOBAL x : INT := 40000; END_VAR END_RESOURCE"),
    source.replace("END_RESOURCE", "END_RESOURCE RESOURCE Second ON Cpu END_RESOURCE"),
    "CONFIGURATION broken",
  ])("rejects unparseable or unrepresentable sources %#", (configurationSource) => {
    expect(writeProject({ ...sampleProject(), configurationSource }).value).toBeNull();
  });

  it.each([
    '<resource name="Second"/>',
    '<pouInstance name="Unscheduled" typeName="Main"/>',
    "<accessVars/>",
    "<configVars/>",
    "<globalVars/>",
  ])("rejects unsupported structure %s", (extra) => {
    const xml = save().replace(
      extra.startsWith("<resource") ? "</configuration>" : "</resource>",
      `${extra}${extra.startsWith("<resource") ? "</configuration>" : "</resource>"}`,
    );
    expect(readProject(xml)).toMatchObject({
      value: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "project.unsupported" }),
      ]),
    });
  });
});
