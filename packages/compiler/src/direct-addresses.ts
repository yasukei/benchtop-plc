import {
  addressBytes,
  addressOffset,
  formatDirectAddress,
  type ConfigurationIR,
  type Diagnostic,
  type DirectAddress,
  type SourceSpan,
} from "@benchtop-plc/core";

/** Bit ranges avoid warnings for independent bits within the same output byte. */
export function outputOverlapWarnings(ir: ConfigurationIR): Diagnostic[] {
  const writers: { address: DirectAddress; span: SourceSpan; pou: string }[] = [];
  for (const variable of ir.variables) {
    if (variable.kind !== "scalar" || variable.address?.area !== "Q") continue;
    const instance = ir.resource.programs.find((p) => p.name === variable.instance);
    writers.push({
      address: variable.address,
      span: variable.span,
      pou: instance ? ir.programs[instance.program]!.name : ir.name,
    });
  }
  for (const instance of ir.resource.programs)
    for (const connection of instance.outputs ?? [])
      if (connection.endpoint.kind === "address" && connection.endpoint.address.area === "Q")
        writers.push({ address: connection.endpoint.address, span: connection.span, pou: ir.name });
  const range = (a: DirectAddress) => {
    const start = addressOffset(a) * 8 + (a.size === "X" ? a.bit : 0);
    return [start, start + (a.size === "X" ? 1 : addressBytes[a.size] * 8)] as const;
  };
  return writers.flatMap((writer, i): Diagnostic[] => {
    const [start, end] = range(writer.address);
    const other = writers.slice(0, i).find((w) => {
      const [otherStart, otherEnd] = range(w.address);
      return start < otherEnd && otherStart < end;
    });
    return other
      ? [
          {
            code: "decl.output-overlap",
            severity: "warning",
            span: writer.span,
            pou: writer.pou,
            args: {
              address: formatDirectAddress(writer.address),
              other: formatDirectAddress(other.address),
            },
          },
        ]
      : [];
  });
}
