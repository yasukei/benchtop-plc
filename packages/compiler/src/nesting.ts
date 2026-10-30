import type { SourceSpan } from "@benchtop-plc/core";
import { FrontendError } from "./diagnostic.js";

/** Syntactic nesting only; named type and function block hierarchies are not counted. */
export const MAX_SOURCE_NESTING = 32;
/** Bounds recursive consumers of flat operator/access trees independently of syntax nesting. */
export const MAX_SOURCE_TREE_DEPTH = 256;

export function nestingError(span: SourceSpan): never {
  throw new FrontendError({
    code: "syntax.nesting-limit",
    severity: "error",
    span,
    args: { limit: MAX_SOURCE_NESTING },
  });
}

function treeDepthError(span: SourceSpan): never {
  throw new FrontendError({
    code: "syntax.tree-depth-limit",
    severity: "error",
    span,
    args: { limit: MAX_SOURCE_TREE_DEPTH },
  });
}

const accessKinds = new Set(["member", "field", "index", "elementBit", "dereference"]);
type Chain = "binary" | "access";

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
  const pending: {
    value: unknown;
    depth: number;
    treeDepth: number;
    span: SourceSpan;
    chain?: Chain;
  }[] = [{ value: root, depth: 0, treeDepth: 0, span: root.span }];
  while (pending.length) {
    const { value, depth, treeDepth, span, chain } = pending.pop()!;
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, depth, treeDepth, span, chain });
      continue;
    }
    const node = value as Record<string, unknown>;
    const location = (node.span as SourceSpan | undefined) ?? span;
    const levels =
      Number(typeof node.kind === "string" && nestedKinds.has(node.kind)) +
      Number("dimensions" in node);
    const kind = typeof node.kind === "string" ? node.kind : "";
    const continues =
      (chain === "binary" && kind === "binary") || (chain === "access" && accessKinds.has(kind));
    const next = depth + levels - Number(continues);
    const nextTree = treeDepth + levels;
    if (next > MAX_SOURCE_NESTING) nestingError(location);
    if (nextTree > MAX_SOURCE_TREE_DEPTH) treeDepthError(location);
    for (const [key, child] of Object.entries(node)) {
      if (key === "span") continue;
      // REF_TO has no separate AST node; its edge introduces the type level.
      const reference =
        (key === "reference" && node.kind !== "dereference") || key === "resultReference";
      const childDepth = next + Number(reference);
      if (reference && childDepth > MAX_SOURCE_NESTING) nestingError(location);
      const childTree = nextTree + Number(reference);
      if (childTree > MAX_SOURCE_TREE_DEPTH) treeDepthError(location);
      // Only the left spine is flat: an operator's right operand or an index
      // expression still starts its own syntax level. Count the total tree
      // depth too, so nested flat chains cannot multiply the recursion budget.
      const childChain: Chain | undefined =
        kind === "binary" && key === "left"
          ? "binary"
          : (kind === "field" && key === "object") ||
              (kind === "index" && key === "array") ||
              (kind === "dereference" && key === "reference") ||
              (kind === "elementBit" && key === "element")
            ? "access"
            : undefined;
      pending.push({
        value: child,
        depth: childDepth,
        treeDepth: childTree,
        span: location,
        chain: childChain,
      });
    }
  }
  return root;
}
