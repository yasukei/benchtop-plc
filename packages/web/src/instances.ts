import type { BodyWatch, ConfigurationIR, RuntimeSnapshot } from "@benchtop-plc/core";
import type { ShellCatalog } from "./catalog.js";

export interface EditorInstance {
  path: string;
  type: string;
}
export type InstanceChoices = Record<string, string>;

/** Resource order first, then declaration order within each instance, then globals.
 * The storage table is allocated depth first (base members first, array index order),
 * but globals are allocated before programs, so visit each program's paths first.
 */
export function instancesForSource(ir: ConfigurationIR, pou: string): EditorInstance[] {
  const key = pou.toUpperCase();
  const program = ir.programs.findIndex((program) => program.name.toUpperCase() === key);
  if (program >= 0)
    return ir.resource.programs.flatMap((instance) =>
      instance.program === program
        ? [{ path: instance.name, type: ir.programs[program]!.name }]
        : [],
    );
  const blocks = ir.functionBlocks ?? [];
  const type = blocks.findIndex((block) => block.name.toUpperCase() === key);
  if (type < 0) return [];
  const matches = (block: number): boolean => {
    for (
      let current: number | undefined = block;
      current !== undefined;
      current = blocks[current]!.base
    )
      if (current === type) return true;
    return false;
  };
  const instances = ir.instances ?? [];
  const programFor = (path: string) =>
    ir.resource.programs.findIndex((program) => path.startsWith(`${program.name}.`));
  return [
    ...ir.resource.programs.flatMap((_, index) =>
      instances.filter((instance) => programFor(instance.path) === index),
    ),
    ...instances.filter((instance) => programFor(instance.path) < 0),
  ].flatMap((instance) =>
    matches(instance.block) ? [{ path: instance.path, type: blocks[instance.block]!.name }] : [],
  );
}

/** Missing remembered paths fall back to the source's first instance. */
export function selectedInstance(
  ir: ConfigurationIR,
  pou: string,
  choices: InstanceChoices,
): EditorInstance | undefined {
  const instances = instancesForSource(ir, pou);
  const remembered = choices[pou.toUpperCase()];
  return instances.find((instance) => instance.path === remembered) ?? instances[0];
}

export function filterInstances(
  instances: readonly EditorInstance[],
  filter: string,
): EditorInstance[] {
  const key = filter.trim().toUpperCase();
  return instances.filter((instance) =>
    `${instance.path} ${instance.type}`.toUpperCase().includes(key),
  );
}

/** Keep every PROGRAM selected, plus the open block, class or function source. */
export function watchedBodies(
  ir: ConfigurationIR,
  choices: InstanceChoices,
  openPou?: string,
): BodyWatch[] {
  const sources = new Set(ir.programs.map((program) => program.name));
  if (openPou) sources.add(openPou);
  return [...sources].flatMap<BodyWatch>((pou) => {
    if (ir.functions?.some((fn) => fn.name.toUpperCase() === pou.toUpperCase()))
      return [{ pou, instance: null }];
    const instance = selectedInstance(ir, pou, choices);
    return instance ? [{ pou, instance: instance.path }] : [];
  });
}

/** The caller belongs to the displayed invocation, even if it ran in an older pass. */
export function functionCallLabel(
  snapshot: RuntimeSnapshot | null,
  pou: string,
  text: ShellCatalog,
): string {
  const caller = snapshot?.annotations.find(
    (body) => body.pou.toUpperCase() === pou.toUpperCase() && body.instance === null,
  )?.caller;
  if (!caller) return text.inlineNeverCalled;
  return (caller.instance === null ? text.inlineCalledFrom : text.inlineCalledFromInstance)
    .replace("{pou}", caller.pou)
    .replace("{instance}", caller.instance ?? "")
    .replace("{line}", String(caller.line));
}
