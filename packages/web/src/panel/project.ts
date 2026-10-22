import { readProject, splitProgram, writeProject, type Project } from "@benchtop-plc/project";
import packageJson from "../../package.json" with { type: "json" };
import { readLayout, type PanelLayout } from "./layout.js";

/** Until the POU list is available, the editor shows the first PROGRAM (or first POU). */
export function editorPouIndex(project: Project): number {
  const index = project.pous.findIndex((source) => splitProgram(source).value?.kind === "program");
  return index < 0 ? 0 : index;
}

export function projectSources(source: string, project: Project | null): string[] {
  if (!project) return [source];
  if (!project.pous.length) return source ? [source] : [];
  return project.pous.map((text, index) => (index === editorPouIndex(project) ? source : text));
}

export function savePanelProject(
  source: string,
  layout: PanelLayout,
  cycleMs: number,
  project: Project | null,
): string | null {
  const result = writeProject({
    ...(project ?? {
      contentHeader: { name: splitProgram(source).value?.name ?? "Project" },
      configuration: "Config",
      resource: "Res",
      task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
    }),
    fileHeader: {
      ...(project?.fileHeader ?? {
        companyName: "benchtop-plc",
        productName: "benchtop-plc",
        creationDateTime: new Date().toISOString(),
      }),
      productVersion: packageJson.version,
    },
    pous: projectSources(source, project),
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
