import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { readProject, writeProject } from "./index.js";
import { sampleProject } from "./codec.test.js";

it("round trips block/class references in TC6 pointers, aliases, arrays and members", () => {
  const project = sampleProject(`PROGRAM Main VAR m: Motor; r: REF_TO Motor; v: Valve;
    c: REF_TO Valve; links: ARRAY[1..2] OF MotorRef; record: Holder; END_VAR
    r := REF(m); c := REF(v); links[2] := r; record.link := c; r^(); c^.Open(); END_PROGRAM`);
  project.pous.push(
    "FUNCTION_BLOCK Motor END_FUNCTION_BLOCK",
    "CLASS Valve METHOD PUBLIC Open END_METHOD END_CLASS",
  );
  project.dataTypes.push(
    "TYPE MotorRef : REF_TO Motor; END_TYPE",
    "TYPE Holder : STRUCT link: REF_TO Valve; END_STRUCT; END_TYPE",
  );
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value).toContain('<pointer><baseType><derived name="MOTOR"/></baseType></pointer>');
  expect(saved.value).toContain('<pointer><baseType><derived name="VALVE"/></baseType></pointer>');
  const opened = readProject(saved.value!);
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value).toEqual(project);
  expect(compileProject(opened.value!.pous, opened.value!.dataTypes).diagnostics).toEqual([]);
});
