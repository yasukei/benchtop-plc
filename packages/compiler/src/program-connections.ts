import {
  resolveType,
  type Diagnostic,
  type SourceNode,
  type ScalarValue,
  type DirectAddress,
} from "@benchtop-plc/core";
import type { CheckedProgram } from "./checked.js";
import type { Configuration } from "./configuration.js";
import { checkConnection } from "./checker.js";

export interface CheckedConnection extends SourceNode {
  parameter: number;
  output: boolean;
  endpoint:
    | { kind: "global"; key: string }
    | { kind: "constant"; value: ScalarValue | null }
    | { kind: "address"; address: DirectAddress };
}

export function checkProgramConnections(
  config: Configuration,
  programs: ReadonlyMap<string, CheckedProgram>,
  globals: CheckedProgram,
): { connections: CheckedConnection[][]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const connections = config.programs.map((instance) => {
    const result: CheckedConnection[] = [];
    const definition = programs.get(instance.type.key);
    if (!definition) return result;
    const seen = new Set<string>();
    for (const connection of instance.connections) {
      const { name, output, value } = connection;
      const report = (
        code:
          | "config.connection-parameter"
          | "config.connection-direction"
          | "config.connection-duplicate"
          | "config.connection-target",
      ) =>
        diagnostics.push({
          code,
          severity: "error",
          args: { name: name.name },
          span: name.span,
          pou: config.name.name,
        });
      const declaration = definition.ast.declarations.find(
        (d) =>
          d.names.some((n) => n.key === name.key) &&
          ["VAR_INPUT", "VAR_OUTPUT"].includes(d.section ?? ""),
      );
      if (!declaration) {
        report("config.connection-parameter");
        continue;
      }
      if (seen.has(name.key)) {
        report("config.connection-duplicate");
        continue;
      }
      seen.add(name.key);
      if (output !== (declaration.section === "VAR_OUTPUT")) {
        report("config.connection-direction");
        continue;
      }
      const symbol = definition.symbols.find((s) => s.name.key === name.key)!;
      const type = symbol.descriptor!;
      if ("area" in value) {
        if (output && value.area === "I") {
          report("config.connection-target");
          continue;
        }
        if (value.byte !== 0 || value.bit > 7) {
          diagnostics.push({
            code: "decl.address-out-of-range",
            severity: "error",
            args: { address: value.text },
            span: value.span,
            pou: config.name.name,
          });
          continue;
        }
        if (resolveType(type, definition.types) !== "BOOL") {
          diagnostics.push({
            code: "decl.direct-address-type",
            severity: "error",
            args: { name: name.name, type: symbol.type },
            span: value.span,
            pou: config.name.name,
          });
          continue;
        }
        result.push({
          span: value.span,
          parameter: symbol.id,
          output,
          endpoint: {
            kind: "address",
            address: { area: value.area, byte: 0, bit: value.bit as DirectAddress["bit"] },
          },
        });
        continue;
      }
      const global =
        value.kind === "name"
          ? globals.symbols.find((s) => s.name.key === value.name.key)
          : undefined;
      const globalDeclaration =
        global &&
        globals.ast.declarations.find((d) => d.names.some((n) => n.key === global.name.key));
      if (output && (!global || globalDeclaration?.address?.area === "I")) {
        report("config.connection-target");
        continue;
      }
      const checked = checkConnection(globals, type, value, output);
      diagnostics.push(...checked.diagnostics.map((d) => ({ ...d, pou: config.name.name })));
      if (checked.diagnostics.some((d) => d.severity === "error") || !checked.info) continue;
      if (!global && checked.info.constant === undefined && !checked.info.nullReference) {
        report("config.connection-target");
        continue;
      }
      result.push({
        span: value.span,
        parameter: symbol.id,
        output,
        endpoint: global
          ? { kind: "global", key: global.name.key }
          : { kind: "constant", value: checked.info.constant ?? null },
      });
    }
    return result;
  });
  return { connections, diagnostics };
}
