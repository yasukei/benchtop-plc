import { sameNamespace } from "./namespaces.js";
import { sameMethodSignature } from "./signatures.js";
import type { Diagnostic, DiagnosticArgs, DiagnosticCode, SourceNode } from "@benchtop-plc/core";
import type { Access, Program } from "./ast.js";
import type { CheckedProgram } from "./checked.js";

/** True for the type itself and its descendants, after the acyclic base pass. */
export function derivesFrom(type: Program | undefined, base: Program): boolean {
  for (let current = type; current; current = current.baseType) if (current === base) return true;
  return false;
}

export function accessible(
  access: Access | undefined,
  declaring: Program,
  from?: Program,
): boolean {
  if (access === "PUBLIC") return true;
  if (access === "INTERNAL") return sameNamespace(declaring, from);
  return access === "PRIVATE" ? from === declaring : derivesFrom(from, declaring);
}

function report<C extends DiagnosticCode>(
  diagnostics: Diagnostic[],
  owner: Program,
  node: SourceNode,
  code: C,
  args: DiagnosticArgs[C],
): void {
  // Generic code/argument correlation is checked by callers.
  diagnostics.push({
    code,
    args,
    severity: "error",
    pou: owner.name.name,
    span: node.span,
  } as Diagnostic);
}

/** Resolve bases before flattening, so a bad graph never reaches member lookup. */
export function resolveInheritance(
  blocks: Program[],
  pous: ReadonlyMap<string, Program>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const visiting = new Set<Program>(),
    visited = new Set<Program>();
  const visit = (type: Program): void => {
    if (visited.has(type)) return;
    visiting.add(type);
    if (type.base) {
      const base = pous.get(type.base.key);
      if (!base)
        report(diagnostics, type, type.base, "inheritance.unknown-base", { name: type.base.name });
      else if (base.kind !== type.kind)
        report(diagnostics, type, type.base, "inheritance.base-kind", { name: base.name.name });
      else if (visiting.has(base))
        report(diagnostics, type, type.base, "inheritance.cycle", { name: base.name.name });
      else {
        visit(base);
        type.baseType = base;
        if (base.final)
          report(diagnostics, type, type.base, "inheritance.final-base", { name: base.name.name });
      }
    }
    visiting.delete(type);
    visited.add(type);
  };
  blocks.forEach(visit);
  if (diagnostics.length) return diagnostics;
  visited.clear();
  const flatten = (type: Program): void => {
    if (visited.has(type)) return;
    const base = type.baseType;
    if (base) flatten(base);
    for (const declaration of type.declarations) {
      declaration.declaringType = type;
      for (const name of declaration.names)
        if (
          base?.declarations.some((d) => d.names.some((n) => n.key === name.key)) ||
          base?.methods?.some((m) => m.name.key === name.key)
        )
          report(diagnostics, type, name, "inheritance.member-collision", { name: name.name });
    }
    for (const section of type.sections ?? []) section.declaringType = type;
    const methods = [...(base?.methods ?? [])];
    const ownNames = new Set<string>();
    for (const method of type.methods ?? []) {
      method.owner = type;
      if (ownNames.has(method.name.key))
        report(diagnostics, type, method.name, "method.name-collision", { name: method.name.name });
      ownNames.add(method.name.key);
      const index = methods.findIndex((m) => m.name.key === method.name.key);
      const inherited = index < 0 ? undefined : methods[index];
      if (base?.declarations.some((d) => d.names.some((n) => n.key === method.name.key)))
        report(diagnostics, type, method.name, "inheritance.member-collision", {
          name: method.name.name,
        });
      if (inherited) {
        if (!method.override)
          report(diagnostics, type, method.name, "inheritance.override-required", {
            name: method.name.name,
          });
        if (inherited.access === "PRIVATE")
          report(diagnostics, type, method.name, "inheritance.override-private", {
            name: method.name.name,
          });
        if (inherited.final)
          report(diagnostics, type, method.name, "inheritance.override-final", {
            name: method.name.name,
          });
        if ((inherited.access ?? "PROTECTED") !== (method.access ?? "PROTECTED"))
          report(diagnostics, type, method.name, "inheritance.override-access", {
            name: method.name.name,
          });
        methods[index] = method;
      } else {
        if (method.override)
          report(diagnostics, type, method.name, "inheritance.override-missing", {
            name: method.name.name,
          });
        methods.push(method);
      }
      if (method.abstract) {
        if (!type.abstract || method.body.length)
          report(diagnostics, type, method.name, "inheritance.abstract-method", {
            name: method.name.name,
          });
        if (method.access === "PRIVATE")
          report(diagnostics, type, method.name, "inheritance.abstract-private", {
            name: method.name.name,
          });
      }
    }
    if (!type.abstract)
      for (const method of methods)
        if (method.abstract)
          report(diagnostics, type, type.name, "inheritance.abstract-unimplemented", {
            name: method.name.name,
          });
    if (type.abstract && type.kind === "functionBlock" && type.body.length)
      report(diagnostics, type, type.name, "inheritance.abstract-body", {});
    if (base) {
      type.declarations = [...base.declarations, ...type.declarations];
      type.sections = [...(base.sections ?? []), ...(type.sections ?? [])];
      if (type.kind === "functionBlock" && !type.body.length)
        type.bodyOwner = base.bodyOwner ?? base;
    }
    if (methods.length) type.methods = methods;
    visited.add(type);
  };
  blocks.forEach(flatten);
  return diagnostics;
}

/** Compare resolved signatures, ignoring local declarations and parameter defaults. */
export function checkOverrides(
  blocks: Program[],
  checked: ReadonlyMap<Program, CheckedProgram>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const type of blocks)
    for (const method of type.methods ?? []) {
      if (method.owner !== type || !method.override) continue;
      const base = type.baseType?.methods?.find((m) => m.name.key === method.name.key);
      if (base && !sameMethodSignature(method, base, checked))
        report(diagnostics, type, method.name, "inheritance.override-signature", {
          name: method.name.name,
        });
    }
  return diagnostics;
}
