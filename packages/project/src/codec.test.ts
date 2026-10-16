import { describe, expect, it } from "vitest";
import {
  PANEL_NAMESPACE,
  readProject,
  SOURCE_NAMESPACE,
  splitProgram,
  writeProject,
} from "./index.js";
import type { Project } from "./index.js";

export function sampleProject(
  program = "PROGRAM Main\nVAR\n x AT %IX0.0 : BOOL;\n count : INT := 16#FF;\n timer : TON;\nEND_VAR\n(* < & > *)\nx := count < 42;\nEND_PROGRAM\n",
): Project {
  return {
    fileHeader: {
      companyName: "Test & Co",
      productName: "benchtop-plc",
      productVersion: "0.0.0",
      creationDateTime: "2026-10-16T12:00:00Z",
    },
    contentHeader: { name: "Demo <project>", author: 'A "B"', version: "1" },
    program,
    configuration: "Config",
    resource: "Res",
    task: { name: "Cyclic", interval: "PT0.01S", priority: 0 },
    instance: { name: "mainInstance", typeName: "Main" },
    panel: {
      parts: [{ kind: "lamp", variable: "x", x: 10, y: 20, label: "運転 < & >" }],
      width: 640,
      height: 480,
    },
  };
}
function xml(project = sampleProject()): string {
  const result = writeProject(project);
  expect(result.diagnostics).toEqual([]);
  expect(result.value).not.toBeNull();
  return result.value!;
}
function stripExtension(input: string, name: string): string {
  return input.replace(new RegExp(`<data name="${name}"[^>]*>[\\s\\S]*?</data>`), "");
}

describe("PLCopen XML", () => {
  it("round trips all project fields and exact editor text", () => {
    const project = sampleProject();
    expect(readProject(xml(project))).toEqual({ value: project, diagnostics: [] });
  });
  it("preserves CRLF, declaration comments, multiple blocks, grouped names and spelling", () => {
    const project = sampleProject(
      "// prefix\r\nprogram Main\r\nVAR (* END_VAR *)\r\n a, b : int := -2;\r\nEND_VAR\r\nVAR\r\n x at %ix0.0 : bool;\r\nEND_VAR\r\n// END_PROGRAM\r\nx := a < b;\r\nend_program; // suffix\r\n",
    );
    expect(readProject(xml(project)).value).toEqual(project);
  });
  it("imports files without proprietary data using canonical declarations", () => {
    const input = stripExtension(stripExtension(xml(), SOURCE_NAMESPACE), PANEL_NAMESPACE);
    const read = readProject(input);
    expect(read.diagnostics).toEqual([]);
    expect(read.value?.panel).toBeNull();
    const parsed = splitProgram(read.value!.program).value!;
    expect(parsed.variables).toEqual(splitProgram(sampleProject().program).value!.variables);
    expect(parsed.body).toContain("x := count < 42;");
    expect(readProject(xml(read.value!)).value).toEqual(read.value);
  });
  it("uses standard XML when the saved editor source is stale", () => {
    const read = readProject(xml().replace('value="16#FF"', 'value="23"'));
    expect(read.diagnostics.map((item) => item.code)).toEqual(["project.stale-source"]);
    expect(read.value?.program).toContain("count : INT := 23;");
  });
  it("ignores namespace prefix spelling", () => {
    const input = xml().replaceAll("xhtml:", "html:").replace("xmlns:xhtml", "xmlns:html");
    expect(readProject(input).value).toEqual(sampleProject());
  });
  it("warns and drops unknown vendor data at root and inside a POU", () => {
    const extension =
      '<addData><data name="https://vendor.example/1" handleUnknown="preserve"><v:payload xmlns:v="https://vendor.example/1"/></data></addData>';
    const input = xml().replace("</pou>", `${extension}</pou>`).replace("</project>", "</project>");
    const read = readProject(input);
    expect(read.value).toEqual(sampleProject());
    expect(read.diagnostics).toMatchObject([{ code: "project.dropped-data", severity: "warning" }]);
    expect(xml(read.value!)).not.toContain("vendor.example");
  });
  it.each([
    "",
    "<project>",
    "<a/>",
    "<!DOCTYPE project [<!ENTITY x 'boom'>]><project/>",
    '<project xmlns="wrong"/>',
    "<x/><y/>",
  ])("diagnoses malformed XML: %s", (input) => {
    const result = readProject(input);
    expect(result.value).toBeNull();
    expect(result.diagnostics[0]?.severity).toBe("error");
  });
  it.each([
    [(text: string) => text.replace(/<fileHeader[^>]*\/>/, ""), "project.missing"],
    [(text: string) => text.replace(/<interface>[\s\S]*?<\/interface>/, ""), "project.missing"],
    [(text: string) => text.replace(/<pouInstance[^>]*\/>/, ""), "project.missing"],
    [(text: string) => text.replace('interval="PT0.01S"', 'interval="PT0S"'), "project.invalid"],
    [(text: string) => text.replace('priority="0"', 'priority="65536"'), "project.invalid"],
    [(text: string) => text.replace('typeName="Main"', 'typeName="Other"'), "project.invalid"],
    [
      (text: string) => text.replace("<pou name=", '<pou pouType="function" name='),
      "project.invalid-xml",
    ],
    [
      (text: string) => text.replace('pouType="program"', 'pouType="function"'),
      "project.unsupported",
    ],
    [
      (text: string) => text.replace("<ST>", "<LD>").replace("</ST>", "</LD>"),
      "project.unsupported",
    ],
    [
      (text: string) =>
        text.replace("<localVars>", "<inputVars>").replace("</localVars>", "</inputVars>"),
      "project.unsupported",
    ],
    [
      (text: string) => text.replace("<dataTypes/>", '<dataTypes><dataType name="T"/></dataTypes>'),
      "project.unsupported",
    ],
    [
      (text: string) => text.replace("</pous>", '<pou name="Other" pouType="program"/></pous>'),
      "project.unsupported",
    ],
    [
      (text: string) => text.replace("</resource>", '<task name="Other"/></resource>'),
      "project.unsupported",
    ],
    [
      (text: string) =>
        text.replace("</configurations>", '<configuration name="Other"/></configurations>'),
      "project.unsupported",
    ],
    [
      (text: string) =>
        text.replace("</configuration>", '<resource name="Other"/></configuration>'),
      "project.unsupported",
    ],
    [
      (text: string) => text.replace("<localVars>", '<localVars retain="true">'),
      "project.unsupported",
    ],
    [
      (text: string) => text.replace('<panel:panel version="1">', '<panel:panel version="2">'),
      "project.unsupported",
    ],
    [
      (text: string) =>
        text.replace('<panel:panel version="1">', '<panel:panel version="1">invalid'),
      "project.invalid",
    ],
    [(text: string) => text.replace('name="count"', 'name="a : INT; b"'), "project.invalid"],
  ] as const)(
    "returns a diagnostic for missing/unsupported/invalid structures %#",
    (change, code) => {
      const result = readProject(change(xml()));
      expect(result.value).toBeNull();
      expect(result.diagnostics.map((item) => item.code)).toContain(code);
    },
  );
  it.each(["PT0.01S", "PT1H2M3.5S", "P1D", "P1DT2H"])("supports cyclic interval %s", (interval) => {
    const project = sampleProject();
    project.task.interval = interval;
    expect(readProject(xml(project)).value).toEqual(project);
  });
  it.each(["PT", "P", "P1Y", "PT-1S", "event", "P1DT", "PT0S"])(
    "rejects noncyclic interval %s",
    (interval) => {
      const project = sampleProject();
      project.task.interval = interval;
      expect(writeProject(project).value).toBeNull();
    },
  );
  it("returns parser diagnostics instead of throwing on invalid ST", () => {
    expect(
      writeProject(sampleProject("PROGRAM Main VAR x : BOOL END_VAR END_PROGRAM")).diagnostics[0]
        ?.code,
    ).toBe("syntax.expected-token");
  });
  it("handles programs without variables", () => {
    const project = sampleProject("PROGRAM Main\n(* keep me *)\nEND_PROGRAM\n");
    expect(readProject(xml(project)).value).toEqual(project);
  });
  it("rejects a direct address shared by multiple names", () => {
    expect(
      writeProject(sampleProject("PROGRAM Main VAR a, b AT %IX0.0 : BOOL; END_VAR END_PROGRAM"))
        .diagnostics[0]?.code,
    ).toBe("decl.at-multiple-names");
  });
});

it("preserves date/time aliases, elementary and derived declarations", () => {
  const project = sampleProject(
    "PROGRAM Main\nVAR\n a : TIME_OF_DAY; b : DATE_AND_TIME; c : STRING; d : WSTRING; fb : MyFB;\nEND_VAR\nEND_PROGRAM\n",
  );
  const written = xml(project);
  expect(written).toContain("<TOD/>");
  expect(written).toContain("<DT/>");
  expect(written).toContain("<string/>");
  expect(written).toContain('<derived name="MYFB"/>');
  expect(readProject(written).value).toEqual(project);
});
it.each([NaN, Infinity, -Infinity, [undefined], new Date(), { x: undefined }])(
  "rejects panel data that cannot round trip as JSON %#",
  (panel) => {
    const project = sampleProject();
    project.panel = panel as Project["panel"];
    expect(writeProject(project)).toMatchObject({
      value: null,
      diagnostics: [{ code: "project.invalid", args: { path: "panel" } }],
    });
  },
);
it("rejects cyclic panel data without throwing", () => {
  const panel: { child?: unknown } = {};
  panel.child = panel;
  const project = sampleProject();
  project.panel = panel as Project["panel"];
  expect(writeProject(project).value).toBeNull();
});
it.each([
  "2026-02-30T00:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-01-01T00:00:00+14:01",
  "0000-01-01T00:00:00Z",
])("rejects invalid XML dates %s", (date) => {
  const project = sampleProject();
  project.fileHeader.creationDateTime = date;
  expect(writeProject(project).value).toBeNull();
});
it("imports an external ST body without surrounding whitespace", () => {
  const input = stripExtension(xml(), SOURCE_NAMESPACE).replace(
    /<xhtml:p>[\s\S]*?<\/xhtml:p>/,
    "<xhtml:p>x := TRUE;</xhtml:p>",
  );
  const result = readProject(input);
  expect(result.diagnostics).toEqual([]);
  expect(result.value?.program).toContain("\nEND_VAR\nx := TRUE;\nEND_PROGRAM");
});
it("accepts CDATA for external ST and rejects nested formatting markup", () => {
  const input = stripExtension(xml(), SOURCE_NAMESPACE).replace(
    /<xhtml:p>[\s\S]*?<\/xhtml:p>/,
    "<xhtml:p><![CDATA[x := count < 42;]]></xhtml:p>",
  );
  expect(readProject(input).diagnostics).toEqual([]);
  expect(
    readProject(
      input.replace("<![CDATA[x := count < 42;]]>", "<xhtml:span>x := TRUE;</xhtml:span>"),
    ).diagnostics[0]?.code,
  ).toBe("project.unsupported");
});
it("does not restore stale source after an external body edit", () => {
  const input = xml().replace(/<xhtml:p>[\s\S]*?<\/xhtml:p>/, "<xhtml:p>x := FALSE;</xhtml:p>");
  const result = readProject(input);
  expect(result.diagnostics[0]?.code).toBe("project.stale-source");
  expect(result.value?.program).toContain("x := FALSE;");
});
it("preserves every supported optional header field", () => {
  const project = sampleProject();
  Object.assign(project.fileHeader, {
    companyURL: "https://example.com",
    productRelease: "beta",
    contentDescription: "Description\nNext line",
  });
  Object.assign(project.contentHeader, {
    organization: "Company",
    modificationDateTime: "2026-10-16T13:00:00+09:00",
    language: "ja-JP",
  });
  expect(readProject(xml(project)).value).toEqual(project);
});
