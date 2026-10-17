import { compile } from "@benchtop-plc/compiler";
import { readProject, writeProject, type Project } from "@benchtop-plc/project";
import { readLayout, type PanelLayout } from "./layout.js";

export function savePanelProject(
  source: string,
  layout: PanelLayout,
  cycleMs: number,
  project: Project | null,
): string | null {
  const ir = compile(source).ir;
  if (!ir) return null;
  const result = writeProject({
    ...(project ?? {
      fileHeader: {
        companyName: "benchtop-plc",
        productName: "benchtop-plc",
        productVersion: "0.0.0",
        creationDateTime: new Date().toISOString(),
      },
      contentHeader: { name: ir.name },
      configuration: "Config",
      resource: "Res",
      task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
      instance: { name: "mainInstance", typeName: ir.name },
    }),
    program: source,
    instance: { ...(project?.instance ?? { name: "mainInstance" }), typeName: ir.name },
    task: {
      ...(project?.task ?? { name: "Cyclic", priority: 1 }),
      interval: `PT${cycleMs / 1000}S`,
    },
    panel: layout.map((part) => ({ ...part })),
  });
  return result.value;
}
export function openPanelProject(xml: string): { project: Project; layout: PanelLayout } | null {
  const result = readProject(xml);
  if (!result.value) return null;
  const layout = result.value.panel === null ? [] : readLayout(result.value.panel);
  return layout ? { project: result.value, layout } : null;
}
