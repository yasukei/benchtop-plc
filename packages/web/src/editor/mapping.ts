import { formatMonitoredValue } from "../monitor.js";
import {
  formatValue,
  type RuntimeSnapshot,
  type ProgramIR,
  type TypeDescriptor,
  type Statement,
  type SourceSpan,
  type TypedValue,
} from "@benchtop-plc/core";

/** Translate one-based, end-exclusive compiler spans into safe editor offsets. */
export function spanRange(source: string, span: SourceSpan): { from: number; to: number } {
  const lines = source.split("\n");
  const offset = (line: number, column: number) => {
    const index = Math.max(0, Math.min(lines.length - 1, line - 1));
    let start = 0;
    for (let i = 0; i < index; i++) start += lines[i]!.length + 1;
    return start + Math.max(0, Math.min(lines[index]!.replace(/\r$/, "").length, column - 1));
  };
  const from = offset(span.line, span.column);
  return { from, to: Math.max(from, offset(span.endLine, span.endColumn)) };
}

export interface InlineValue {
  text: string;
  dataType: TypedValue["dataType"] | "reference";
}
export interface InlineAnnotation {
  line: number;
  position: number;
  values: InlineValue[];
}

/** The start line is authoritative, including multiline calls and same-line statements. */
export function mapAnnotations(
  source: string,
  snapshot: RuntimeSnapshot | null,
  online: boolean,
  ir?: ProgramIR,
): InlineAnnotation[] {
  if (!online || !snapshot) return [];
  const descriptors = new Map<string, TypeDescriptor>();
  const spanKey = (span: SourceSpan) =>
    `${span.line}:${span.column}:${span.endLine}:${span.endColumn}`;
  const visit = (statements: readonly Statement[]): void => {
    for (const statement of statements) {
      if (statement.kind === "assignment")
        descriptors.set(spanKey(statement.span), statement.target.dataType);
      else if (statement.kind === "call" && statement.call.dataType)
        descriptors.set(spanKey(statement.span), statement.call.dataType);
      else if (statement.kind === "if" || statement.kind === "case") {
        for (const branch of statement.branches) visit(branch.body);
        visit(statement.elseBody);
      } else if (
        statement.kind === "for" ||
        statement.kind === "while" ||
        statement.kind === "repeat"
      )
        visit(statement.body);
    }
  };
  if (ir) visit(ir.body);
  const lines = source.split("\n");
  const positions: number[] = [];
  let offset = 0;
  for (const line of lines) {
    positions.push(offset + line.replace(/\r$/, "").length);
    offset += line.length + 1;
  }
  return Object.entries(snapshot.annotations)
    .sort(([a], [b]) => Number(a) - Number(b))
    .flatMap(([key, entries]) => {
      const line = Number(key);
      const position = positions[line - 1];
      if (!Number.isInteger(line) || position === undefined) return [];
      const values = entries
        .filter((entry) => entry.span.line === line)
        .toSorted((a, b) => a.span.column - b.span.column)
        .flatMap((entry) =>
          entry.values.map((value) => ({
            text:
              "target" in value
                ? (value.target ?? "NULL")
                : descriptors.has(spanKey(entry.span))
                  ? formatMonitoredValue(descriptors.get(spanKey(entry.span))!, value, ir?.types)
                  : formatValue(value.dataType, value.value),
            dataType: "target" in value ? ("reference" as const) : value.dataType,
          })),
        );
      return values.length ? [{ line, position, values }] : [];
    });
}
