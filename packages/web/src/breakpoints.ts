import { ChangeSet, Text } from "@codemirror/state";
import type { Breakpoint, ConfigurationIR, Statement } from "@benchtop-plc/core";

export type SourceBreakpoints = Record<string, number[]>;

/** Programmatic edits preserve matching lines; editor edits supply their exact changes. */
export function sourceChanges(before: string, after: string): ChangeSet {
  const oldLines = before.split("\n"),
    newLines = after.split("\n");
  let first = 0,
    oldLast = oldLines.length,
    newLast = newLines.length;
  while (first < oldLast && first < newLast && oldLines[first] === newLines[first]) first++;
  while (oldLast > first && newLast > first && oldLines[oldLast - 1] === newLines[newLast - 1]) {
    oldLast--;
    newLast--;
  }
  if (oldLast - first > 1 || newLast - first > 1 || oldLast === first || newLast === first) {
    const offset = (lines: string[], line: number) =>
      lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0);
    const from = Math.min(before.length, after.length, offset(oldLines, first));
    const to = Math.min(before.length, offset(oldLines, oldLast));
    const newEnd = Math.min(after.length, offset(newLines, newLast));
    return ChangeSet.of({ from, to, insert: after.slice(from, newEnd) }, before.length);
  }
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let oldEnd = before.length,
    newEnd = after.length;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return ChangeSet.of({ from, to: oldEnd, insert: after.slice(from, newEnd) }, before.length);
}

/** Track line identity, dropping deleted lines and leaving inserted lines without a loaded origin. */
export function mapSourceLines(
  before: string,
  after: string,
  origins: readonly (number | null)[],
  changes = sourceChanges(before, after),
): (number | null)[] {
  const oldDoc = Text.of(before.split("\n"));
  const newDoc = Text.of(after.split("\n"));
  const mapped: (number | null)[] = Array<null>(newDoc.lines).fill(null);
  for (let line = 1; line <= oldDoc.lines; line++) {
    const old = oldDoc.line(line);
    let removed = false;
    changes.iterChanges((from, to, _a, _b, inserted) => {
      const end = line < oldDoc.lines ? old.to + 1 : old.to;
      if (to > from && from <= old.from && to >= end && !inserted.length) removed = true;
      // Replacing whole lines removes their identity too.
      if (to > from && from <= old.from && to > old.to && inserted.lines > 1) removed = true;
    });
    if (removed) continue;
    const position = changes.mapPos(old.from, 1);
    const target = newDoc.lineAt(Math.min(position, newDoc.length)).number;
    if (mapped[target - 1] === null) mapped[target - 1] = origins[line - 1] ?? null;
  }
  return mapped;
}

export function mapBreakpointLines(
  before: string,
  after: string,
  lines: readonly number[],
  changes?: ChangeSet,
): number[] {
  const origins = mapSourceLines(
    before,
    after,
    before.split("\n").map((_, i) => i + 1),
    changes,
  );
  return origins.flatMap((origin, i) => (origin !== null && lines.includes(origin) ? [i + 1] : []));
}

/** Source names also cover methods declared in that source, excluding inherited copies. */
export function haltPoints(ir: ConfigurationIR, source: string): Breakpoint[] {
  const points: Breakpoint[] = [];
  const visit = (pou: string, statements: readonly Statement[]) => {
    for (const statement of statements) {
      points.push({ pou, line: statement.span.line });
      if (statement.kind === "if" || statement.kind === "case") {
        for (const branch of statement.branches) visit(pou, branch.body);
        visit(pou, statement.elseBody);
      } else if (
        statement.kind === "for" ||
        statement.kind === "while" ||
        statement.kind === "repeat"
      )
        visit(pou, statement.body);
    }
  };
  const key = source.toUpperCase();
  for (const program of ir.programs)
    if (program.name.toUpperCase() === key) visit(program.name, program.body);
  for (const fn of ir.functions ?? []) if (fn.name.toUpperCase() === key) visit(fn.name, fn.body);
  ir.functionBlocks?.forEach((block, index) => {
    if (block.name.toUpperCase() !== key) return;
    if (block.bodyOwner === undefined || block.bodyOwner === index) visit(block.name, block.body);
    for (const method of block.methods ?? [])
      if ((method.declaringType ?? index) === index)
        visit(`${block.name}.${method.name}`, method.body);
  });
  return points;
}
