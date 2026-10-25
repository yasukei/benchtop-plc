import type { Diagnostic, SourceNode } from "@benchtop-plc/core";
import { isFunctionBlockType, isStandardFunction } from "@benchtop-plc/core";
import type { DataTypeDeclaration, Identifier, Program, SourceScope } from "./ast.js";
import type { Configuration } from "./configuration.js";
import { isElementaryTypeName } from "./lexer.js";
import { isReservedStandardName } from "./reserved-names.js";

type Source = Program | DataTypeDeclaration;
const standard = (key: string): boolean =>
  isElementaryTypeName(key) ||
  isFunctionBlockType(key) ||
  isStandardFunction(key) ||
  isReservedStandardName(key);

/** INTERNAL includes descendants, with a segment boundary (A does not contain AB). */
export function sameNamespace(declaring: SourceScope, from?: SourceScope): boolean {
  const namespace = declaring.namespace?.key;
  return (
    !namespace ||
    from?.namespace?.key === namespace ||
    !!from?.namespace?.key.startsWith(`${namespace}.`)
  );
}

/** Qualify lexical references before inheritance flattens declarations from other sources.
 * The codec uses this same pass to put qualified references in standard TC6 fields.
 */
export function resolveNamespaces(
  sources: readonly Source[],
  configuration?: Configuration,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const declarations = new Map(sources.map((source) => [source.name.key, source]));
  const namespaces = new Set<string>();
  for (const source of sources) {
    const segments = source.namespace?.key.split(".") ?? [];
    for (let length = 1; length <= segments.length; length++)
      namespaces.add(segments.slice(0, length).join("."));
  }
  const roots = new Set([...namespaces].map((name) => name.split(".")[0]!));
  const report = (
    source: Source | Configuration,
    node: SourceNode,
    code:
      | "namespace.unknown"
      | "namespace.ambiguous"
      | "namespace.internal"
      | "namespace.internal-global"
      | "decl.name-collision",
    name: string,
  ): void => {
    diagnostics.push({
      code,
      severity: "error",
      pou: source.name.name,
      span: node.span,
      args: code === "decl.name-collision" ? { name, kind: "type" } : { name },
    } as Diagnostic);
  };
  const candidates = (name: Identifier, scope: SourceScope): Source[] => {
    if (name.key.includes("."))
      return declarations.has(name.key) ? [declarations.get(name.key)!] : [];
    const path = scope.namespace?.key.split(".") ?? [];
    while (path.length) {
      const found = declarations.get(`${path.join(".")}.${name.key}`);
      if (found) return [found];
      path.pop();
    }
    return [
      ...new Set([name.key, ...(scope.using ?? []).map((ns) => `${ns.key}.${name.key}`)]),
    ].flatMap((key) => (declarations.has(key) ? [declarations.get(key)!] : []));
  };
  const resolve = (name: Identifier, scope: SourceScope, source: Source | Configuration): void => {
    const found = candidates(name, scope);
    if (found.length > 1) {
      report(source, name, "namespace.ambiguous", name.name);
      return;
    }
    const target = found[0];
    if (target) {
      if (target.internal && !sameNamespace(target, scope))
        report(source, name, "namespace.internal", target.name.name);
      if (target.namespace) {
        name.name = target.name.name;
        name.key = target.name.key;
      }
    } else if (name.key.includes(".")) report(source, name, "namespace.unknown", name.name);
  };
  for (const source of sources) {
    if (source.internal && !source.namespace)
      report(source, source.name, "namespace.internal-global", source.name.name);
    if (
      namespaces.has(source.name.key) ||
      roots.has(source.name.key) ||
      (source.namespace && standard(source.simpleName!.key))
    )
      report(source, source.simpleName ?? source.name, "decl.name-collision", source.name.name);
    if (source.namespace && standard(source.namespace.key.split(".")[0]!))
      report(source, source.namespace, "decl.name-collision", source.namespace.name);
    for (const name of source.using ?? [])
      if (!namespaces.has(name.key)) report(source, name, "namespace.unknown", name.name);
    // Methods share the namespace/imports of their source, before inheritance creates links.
    const bodies = "body" in source ? [source, ...(source.methods ?? [])] : [];
    for (const body of bodies) {
      if (source.namespace) body.namespace = source.namespace;
      if (source.using) body.using = source.using;
    }
    const walk = (value: unknown, locals: Set<string>): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((item) => walk(item, locals));
        return;
      }
      const node = value as Record<string, unknown>;
      if (node.kind === "functionCall") {
        const call = value as import("./ast.js").FunctionCall;
        const path = (receiver: import("./ast.js").AssignmentTarget): string | undefined => {
          if (receiver.kind === "name") return receiver.name.name;
          if (receiver.kind === "member")
            return `${receiver.instance.name}.${receiver.member.name}`;
          if (receiver.kind === "field") {
            const prefix = path(receiver.object);
            return prefix && `${prefix}.${receiver.member.name}`;
          }
          return undefined;
        };
        const prefix = call.receiver && path(call.receiver);
        // Namespace roots are reserved against variables, so only those paths
        // can be absolute POU names. Keep instance receivers for the checker.
        if (prefix && roots.has(prefix.split(".")[0]!.toUpperCase())) {
          call.name = {
            ...call.name,
            name: `${prefix}.${call.name.name}`,
            key: `${prefix.toUpperCase()}.${call.name.key}`,
          };
          delete call.receiver;
          resolve(call.name, source, source);
        } else if (!call.receiver && !call.instance && !locals.has(call.name.key))
          resolve(call.name, source, source);
      }
      if (node.kind === "fbCall") {
        const call = value as import("./ast.js").FunctionBlockCall;
        if (!locals.has(call.instance.key)) resolve(call.instance, source, source);
      }
      if (node.kind === "declaration") {
        for (const name of (value as import("./ast.js").Declaration).names)
          if (
            roots.has(name.key) ||
            candidates(name, source).some(
              (item) => item.namespace && (sameNamespace(item, source) || !item.internal),
            )
          )
            report(source, name, "decl.name-collision", name.name);
      }
      // Named type sites include inline arrays/references, enum literals and results.
      for (const key of ["typeName", "resultType", "base"])
        if (node[key]) resolve(node[key] as Identifier, source, source);
      for (const key of ["extends", "implements"])
        for (const name of (node[key] as Identifier[] | undefined) ?? [])
          resolve(name, source, source);
      for (const [key, child] of Object.entries(node))
        if (
          ![
            "name",
            "namespace",
            "using",
            "simpleName",
            "typeName",
            "resultType",
            "base",
            "extends",
            "implements",
            "methods",
          ].includes(key)
        )
          walk(child, locals);
    };
    if ("body" in source) {
      const memberNames = (owner: Program, seen = new Set<Program>()): string[] => {
        if (seen.has(owner)) return [];
        seen.add(owner);
        const parent = owner.base && candidates(owner.base, owner)[0];
        return [
          ...owner.declarations.flatMap((d) => d.names.map((n) => n.key)),
          ...(owner.methods ?? []).map((method) => method.name.key),
          ...(parent && "body" in parent ? memberNames(parent, seen) : []),
        ];
      };
      const members = memberNames(source);
      for (const body of bodies) {
        const locals = new Set([
          ...members,
          ...body.declarations.flatMap((d) => d.names.map((n) => n.key)),
        ]);
        // Avoid traversing methods twice, with the wrong method's locals.
        walk(body, locals);
      }
    } else walk(source, new Set());
  }
  if (configuration) {
    for (const instance of configuration.programs) resolve(instance.type, {}, configuration);
    const names = [
      configuration.name,
      configuration.resource,
      ...configuration.tasks.map((task) => task.name),
      ...configuration.programs.map((instance) => instance.name),
    ];
    for (const name of names)
      if (roots.has(name.key)) report(configuration, name, "decl.name-collision", name.name);
    const walkGlobals = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(walkGlobals);
        return;
      }
      const node = value as Record<string, unknown>;
      if (node.typeName) resolve(node.typeName as Identifier, {}, configuration);
      if (node.kind === "declaration")
        for (const name of (value as import("./ast.js").Declaration).names)
          if (roots.has(name.key)) report(configuration, name, "decl.name-collision", name.name);
      Object.values(node).forEach(walkGlobals);
    };
    walkGlobals([...configuration.globals, ...configuration.resourceGlobals]);
  }
  return diagnostics;
}
