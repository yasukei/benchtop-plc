import { methodImplementation } from "@benchtop-plc/core";
import type {
  AnnotatedBody,
  BodyWatch,
  ConfigurationIR,
  ProgramIR,
  Statement,
  StatementAnnotation,
} from "@benchtop-plc/core";

export function bodyKey(pou: string, instance: string | null): string {
  return JSON.stringify([pou.toUpperCase(), instance?.toUpperCase() ?? null]);
}

/** A type watch includes the code of all its methods, including inherited methods. */
export function watchedBodyKeys(
  ir: ProgramIR | ConfigurationIR,
  watches: readonly BodyWatch[],
): Set<string> {
  const keys = new Set<string>();
  for (const watch of watches) {
    keys.add(bodyKey(watch.pou, watch.instance));
    const blockIndex =
      ir.functionBlocks?.findIndex(
        (block) => block.name.toUpperCase() === watch.pou.toUpperCase(),
      ) ?? -1;
    const block = ir.functionBlocks?.[blockIndex];
    for (const [slot] of (block?.methods ?? []).entries()) {
      const method = methodImplementation(ir.functionBlocks!, blockIndex, slot);
      const owner =
        method.declaringType === undefined ? block! : ir.functionBlocks![method.declaringType]!;
      keys.add(bodyKey(`${owner.name}.${method.name}`, watch.instance));
    }
  }
  return keys;
}

export function annotationLines(
  entries: ReadonlyMap<Statement, StatementAnnotation>,
): AnnotatedBody["lines"] {
  const lines: AnnotatedBody["lines"] = {};
  for (const entry of entries.values())
    (lines[entry.span.line] ??= []).push({
      span: { ...entry.span },
      values: entry.values.map((value) => ({ ...value })),
    });
  for (const line of Object.values(lines)) line.sort((a, b) => a.span.column - b.span.column);
  return lines;
}
