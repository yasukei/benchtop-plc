import type { Diagnostic, TypeTable } from "@benchtop-plc/core";
import type { Program } from "./ast.js";
import type { CheckedProgram } from "./checked.js";
import { sameMethodSignature } from "./signatures.js";

export function resolveInterfaces(asts: Program[], pous: ReadonlyMap<string, Program>) {
  const diagnostics: Diagnostic[] = [];
  const conflicts: [Program, Program, Program][] = [];
  const visiting = new Set<Program>(),
    visited = new Set<Program>();
  const report = (owner: Program, code: "interface.unknown" | "interface.cycle", name: string) =>
    diagnostics.push({
      code,
      severity: "error",
      pou: owner.name.name,
      span: owner.name.span,
      args: { name },
    });
  const visit = (type: Program): void => {
    if (visited.has(type)) return;
    visiting.add(type);
    const methods = new Map<string, Program>();
    const bases = new Set<string>();
    for (const name of type.extends ?? []) {
      const base = pous.get(name.key);
      if (base?.kind !== "interface") {
        report(type, "interface.unknown", name.name);
        continue;
      }
      if (visiting.has(base)) {
        report(type, "interface.cycle", name.name);
        continue;
      }
      visit(base);
      bases.add(base.name.key);
      for (const inherited of base.implemented ?? []) bases.add(inherited);
      for (const method of base.methods ?? []) {
        const previous = methods.get(method.name.key);
        if (previous) conflicts.push([type, previous, method]);
        else methods.set(method.name.key, method);
      }
    }
    const ownNames = new Set<string>();
    for (const method of type.methods ?? []) {
      if (ownNames.has(method.name.key))
        diagnostics.push({
          code: "method.name-collision",
          severity: "error",
          pou: type.name.name,
          span: method.name.span,
          args: { name: method.name.name },
        });
      ownNames.add(method.name.key);
      const previous = methods.get(method.name.key);
      if (previous) conflicts.push([type, previous, method]);
      methods.set(method.name.key, method);
    }
    type.methods = [...methods.values()];
    type.implemented = [...bases];
    visiting.delete(type);
    visited.add(type);
  };
  asts.forEach(visit);
  const types: TypeTable = asts.map((type) => ({
    name: type.name.name,
    definition: {
      kind: "alias",
      type: { kind: "interface", name: type.name.key, extends: type.implemented ?? [] },
    },
    initialValue: null,
  }));
  return { diagnostics, conflicts, types };
}

/** Resolve signatures after data types, including aliases and aggregate parameters. */
export function checkInterfaces(
  blocks: Program[],
  pous: ReadonlyMap<string, Program>,
  checked: ReadonlyMap<Program, CheckedProgram>,
  conflicts: [Program, Program, Program][],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (
    owner: Program,
    code: "interface.signature" | "interface.unimplemented" | "interface.unknown",
    name: string,
  ) =>
    diagnostics.push({
      code,
      severity: "error",
      pou: owner.name.name,
      span: owner.name.span,
      args: { name },
    });
  for (const [owner, a, b] of conflicts)
    if (!sameMethodSignature(a, b, checked)) report(owner, "interface.signature", b.name.name);
  const visited = new Set<Program>();
  const visit = (type: Program): void => {
    if (visited.has(type)) return;
    if (type.baseType) visit(type.baseType);
    const names = new Set(type.baseType?.implemented ?? []);
    for (const name of type.implements ?? []) {
      const face = pous.get(name.key);
      if (face?.kind !== "interface") {
        report(type, "interface.unknown", name.name);
        continue;
      }
      names.add(face.name.key);
      for (const base of face.implemented ?? []) names.add(base);
    }
    type.implemented = [...names];
    for (const name of names)
      for (const prototype of pous.get(name)!.methods ?? []) {
        const method = type.methods?.find((m) => m.name.key === prototype.name.key);
        if (
          !type.abstract &&
          (!method ||
            method.abstract ||
            method.access !== "PUBLIC" ||
            !sameMethodSignature(method, prototype, checked))
        )
          report(type, "interface.unimplemented", prototype.name.name);
      }
    visited.add(type);
  };
  blocks.forEach(visit);
  return diagnostics;
}
