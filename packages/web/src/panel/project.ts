import { readProject, splitProgram, writeProject, type Project } from "@benchtop-plc/project";
import type { Diagnostic } from "@benchtop-plc/core";
import packageJson from "../../package.json" with { type: "json" };
import { isNumericPart, readLayout, type PanelLayout } from "./layout.js";

export function serializePanelProject(
  sources: string[],
  layout: PanelLayout,
  cycleMs: number,
  project: Project | null,
  dataTypes: string[],
  configurationSource: string | null = project?.configurationSource ?? null,
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
    configurationSource: configurationSource ?? undefined,
    dataTypes,
    pous: sources,
    task: {
      ...(project?.task ?? { name: "Cyclic", priority: 1 }),
      interval: `PT${cycleMs / 1000}S`,
    },
    panel: layout.map((part) => {
      if (!isNumericPart(part)) return { ...part };
      return {
        id: part.id,
        kind: part.kind,
        label: part.label,
        x: part.x,
        y: part.y,
        address: part.address,
        dataType: part.dataType!,
        ...(part.min === undefined ? {} : { min: part.min }),
        ...(part.max === undefined ? {} : { max: part.max }),
      };
    }),
  });
  return result;
}
export function savePanelProject(...args: Parameters<typeof serializePanelProject>): string | null {
  return serializePanelProject(...args).value;
}
export function openPanelProject(
  xml: string,
): { project: Project; layout: PanelLayout; diagnostics: Diagnostic[] } | null {
  const result = readProject(xml);
  if (!result.value) return null;
  const layout = result.value.panel === null ? [] : readLayout(result.value.panel);
  if (!layout) return null;
  const seen = new Set<string>();
  const diagnostics = result.diagnostics.filter((diagnostic) => {
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { project: result.value, layout, diagnostics };
}
