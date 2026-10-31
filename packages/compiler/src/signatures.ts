import { sameScalarType } from "@benchtop-plc/core";
import type { Program } from "./ast.js";
import type { CheckedProgram } from "./checked.js";

/** Compare resolved project signatures, ignoring locals and parameter defaults. */
export function sameMethodSignature(
  a: Program,
  b: Program,
  checked: ReadonlyMap<Program, CheckedProgram>,
): boolean {
  const left = checked.get(a),
    right = checked.get(b);
  if (!left || !right) return left === right;
  if (left.result || right.result) {
    if (
      !left.result ||
      !right.result ||
      !sameScalarType(left.result.descriptor!, right.result.descriptor!, left.types)
    )
      return false;
  }
  const parameters = (info: CheckedProgram) =>
    info.ast.declarations
      .filter((d) => ["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT"].includes(d.section ?? ""))
      .flatMap((d) =>
        d.names.map((name) => ({
          name: name.key,
          section: d.section,
          type: info.symbols[info.references.get(name)!.variable]!.descriptor!,
        })),
      );
  const lp = parameters(left),
    rp = parameters(right);
  return (
    lp.length === rp.length &&
    lp.every((parameter, index) => {
      const other = rp[index]!;
      return (
        parameter.name === other.name &&
        parameter.section === other.section &&
        sameScalarType(parameter.type, other.type, left.types)
      );
    })
  );
}
