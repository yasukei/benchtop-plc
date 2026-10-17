import {
  formatValue,
  type RuntimeSnapshot,
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
  dataType: TypedValue["dataType"];
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
): InlineAnnotation[] {
  if (!online || !snapshot) return [];
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
            text: formatValue(value.dataType, value.value),
            dataType: value.dataType,
          })),
        );
      return values.length ? [{ line, position, values }] : [];
    });
}
