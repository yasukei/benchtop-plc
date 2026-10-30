import type { SourceSpan } from "@benchtop-plc/core";
import { FrontendError } from "./diagnostic.js";

/** Syntactic nesting only; named type and function block hierarchies are not counted. */
export const MAX_SOURCE_NESTING = 32;

export function nestingError(span: SourceSpan): never {
  throw new FrontendError({
    code: "syntax.nesting-limit",
    severity: "error",
    span,
    args: { limit: MAX_SOURCE_NESTING },
  });
}

const nestedKinds = new Set([
  "group",
  "unary",
  "binary",
  "functionCall",
  "fbCall",
  "member",
  "field",
  "index",
  "elementBit",
  "dereference",
  "arrayInitializer",
  "structureInitializer",
  "if",
  "case",
  "for",
  "while",
  "repeat",
]);

/**
 * Check the raw, acyclic AST before name resolution adds links to other sources.
 * Iteration also catches trees built by parser loops (a+b+c, a.b.c, a^^^).
 * Arrays and grammar containers do not add levels; recursive syntax forms do.
 */
export function checkNesting<T extends { span: SourceSpan }>(root: T): T {
  const pending: { value: unknown; depth: number; span: SourceSpan }[] = [
    { value: root, depth: 0, span: root.span },
  ];
  while (pending.length) {
    const { value, depth, span } = pending.pop()!;
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, depth, span });
      continue;
    }
    const node = value as Record<string, unknown>;
    const location = (node.span as SourceSpan | undefined) ?? span;
    const levels =
      Number(typeof node.kind === "string" && nestedKinds.has(node.kind)) +
      Number("dimensions" in node);
    const next = depth + levels;
    if (next > MAX_SOURCE_NESTING) nestingError(location);
    for (const [key, child] of Object.entries(node)) {
      if (key === "span") continue;
      // REF_TO has no separate AST node; its edge introduces the type level.
      const reference =
        (key === "reference" && node.kind !== "dereference") || key === "resultReference";
      const childDepth = next + Number(reference);
      if (reference && childDepth > MAX_SOURCE_NESTING) nestingError(location);
      pending.push({ value: child, depth: childDepth, span: location });
    }
  }
  return root;
}
