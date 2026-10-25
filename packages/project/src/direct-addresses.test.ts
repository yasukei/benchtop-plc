import { expect, it } from "vitest";
import { readProject, writeProject } from "./index.js";

it("round trips every direct size and area through TC6 addresses and generated ST", () => {
  const project: import("./model.js").Project = {
    fileHeader: {
      companyName: "Test",
      productName: "Test",
      productVersion: "0.5.0",
      creationDateTime: "2026-10-24T00:00:00Z",
    },
    contentHeader: { name: "Direct addresses" },
    dataTypes: [],
    pous: [],
    configuration: "Config",
    resource: "Res",
    task: { name: "Cyclic", interval: "PT0.01S", priority: 0 },
    panel: null,
  };
  const addresses = [
    "%IX63.7",
    "%IB63",
    "%IW31",
    "%ID15",
    "%IL7",
    "%QX1.0",
    "%QB63",
    "%QW31",
    "%QD15",
    "%QL7",
    "%MX1023.7",
    "%MB1023",
    "%MW511",
    "%MD255",
    "%ML127",
  ];
  const types = ["BOOL", "BYTE", "INT", "REAL", "LREAL"];
  const source = `PROGRAM Main VAR ${addresses.map((a, i) => `v${i} AT ${a} : ${types[i % 5]};`).join(" ")} END_VAR END_PROGRAM`;
  project.pous = [source];
  project.configurationSource = `CONFIGURATION Plant VAR_GLOBAL sample AT %IW0 : INT; END_VAR
    RESOURCE Station ON Cpu VAR_GLOBAL flags AT %MW0 : WORD := 16#0102; END_VAR
    TASK T (INTERVAL := T#10ms, PRIORITY := 1); PROGRAM A WITH T : Main;
    END_RESOURCE END_CONFIGURATION`;
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  for (const address of addresses) expect(saved.value).toContain(`address="${address}"`);
  const opened = readProject(saved.value!);
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value?.pous).toEqual([source]);
  expect(opened.value?.configurationSource).toBe(project.configurationSource);
  const withoutSource = saved.value!.replace(
    /<data name="https:\/\/github.com\/yasukei\/benchtop-plc\/ns\/source\/1"[^>]*>[\s\S]*?<\/data>/g,
    "",
  );
  const generated = readProject(withoutSource);
  expect(generated.diagnostics).toEqual([]);
  for (const address of addresses) expect(generated.value?.pous[0]).toContain(`AT ${address}`);
  expect(generated.value?.configurationSource).toContain("flags AT %MW0");
});
