import { readProject, splitProgram, writeProject, type Project } from "@benchtop-plc/project";
import packageJson from "../../package.json" with { type: "json" };
import { readLayout, type PanelLayout } from "./layout.js";

export function serializePanelProject(
  sources: string[],
  layout: PanelLayout,
  cycleMs: number,
  project: Project | null,
) {
  const result = writeProject({
    ...(project ?? {
      contentHeader: { name: splitProgram(sources[0] ?? "").value?.name ?? "Project" },
      configuration: "Config",
      resource: "Res",
      task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
    }),
    fileHeader: {
      ...(project?.fileHeader ?? {
        creationDateTime: new Date().toISOString(),
      }),
      companyName: "benchtop-plc",
      productName: "benchtop-plc",
      productVersion: packageJson.version,
      companyURL: undefined,
      productRelease: undefined,
    },
    dataTypes: project?.dataTypes ?? [],
    pous: sources,
    task: {
      ...(project?.task ?? { name: "Cyclic", priority: 1 }),
      interval: `PT${cycleMs / 1000}S`,
    },
    panel: layout.map((part) => ({ ...part })),
  });
  return result;
}
export function savePanelProject(...args: Parameters<typeof serializePanelProject>): string | null {
  return serializePanelProject(...args).value;
}
export function openPanelProject(xml: string): { project: Project; layout: PanelLayout } | null {
  const result = readProject(xml);
  if (!result.value) return null;
  const layout = result.value.panel === null ? [] : readLayout(result.value.panel);
  return layout ? { project: result.value, layout } : null;
}
