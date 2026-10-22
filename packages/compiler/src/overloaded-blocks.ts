import type { DataType, FunctionBlockType } from "@benchtop-plc/core";
import type { Expression, Statement } from "./ast.js";
import { assignable, commonType } from "./type-rules.js";

export const selectingPort = (type: string): "PT" | "PV" | null =>
  ["TON", "TOF", "TP"].includes(type) ? "PT" : ["CTU", "CTD", "CTUD"].includes(type) ? "PV" : null;

/** Reads of inferred ports exclude the whole expression, even inside a fixed-result call. */
export function readsInferredMember(node: Expression, instances: ReadonlySet<string>): boolean {
  switch (node.kind) {
    case "member":
      return instances.has(node.instance.key) && ["PT", "PV", "ET", "CV"].includes(node.member.key);
    case "group":
      return readsInferredMember(node.expression, instances);
    case "unary":
      return readsInferredMember(node.operand, instances);
    case "binary":
      return (
        readsInferredMember(node.left, instances) || readsInferredMember(node.right, instances)
      );
    case "functionCall":
      return node.args.some((arg) => readsInferredMember(arg, instances));
    case "literal":
    case "name":
      return false;
  }
}

/** Visit bindings in every branch, including unreachable code, within this POU only. */
export function visitBlockBindings(
  statements: readonly Statement[],
  visit: (instance: string, port: string, value: Expression) => void,
): void {
  for (const node of statements) {
    switch (node.kind) {
      case "assignment":
        if (node.target.kind === "member")
          visit(node.target.instance.key, node.target.member.key, node.value);
        break;
      case "call":
        node.call.args.forEach((value, index) => {
          const port = node.call.inputNames?.[index];
          if (port) visit(node.call.name.key, port.key, value);
        });
        break;
      case "fbCall":
        for (const input of node.inputs) visit(node.instance.key, input.name.key, input.value);
        break;
      case "if":
      case "case":
        for (const branch of node.branches) visitBlockBindings(branch.body, visit);
        visitBlockBindings(node.elseBody, visit);
        break;
      case "for":
      case "while":
      case "repeat":
        visitBlockBindings(node.body, visit);
        break;
      case "exit":
      case "return":
        break;
    }
  }
}

export function blockVariant(type: string, types: readonly DataType[]): FunctionBlockType | null {
  const common = commonType(types);
  if (!common) return null;
  const candidates =
    selectingPort(type) === "PT"
      ? (["TIME", "LTIME"] as const)
      : (["INT", "DINT", "UDINT", "LINT", "ULINT"] as const);
  const variant = candidates.find((candidate) => assignable(candidate, common));
  if (!variant) return null;
  // Keep legacy IR for the TIME/INT aliases, including the shipped examples.
  return (variant === candidates[0] ? type : `${type}_${variant}`) as FunctionBlockType;
}
