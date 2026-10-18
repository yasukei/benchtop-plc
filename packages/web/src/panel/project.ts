import { compile } from "@benchtop-plc/compiler";
import { readProject, writeProject, type Project } from "@benchtop-plc/project";
import packageJson from "../../package.json" with { type: "json" };
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
      contentHeader: { name: ir.name },
      configuration: "Config",
      resource: "Res",
      task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
      instance: { name: "mainInstance", typeName: ir.name },
    }),
    fileHeader: {
      ...(project?.fileHeader ?? {
        companyName: "benchtop-plc",
        productName: "benchtop-plc",
        creationDateTime: new Date().toISOString(),
      }),
      productVersion: packageJson.version,
    },
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
