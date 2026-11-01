import type {
  CalendarType,
  ConversionFunction,
  ScalarValue,
  TypeDescriptor,
} from "@benchtop-plc/core";
import {
  calendarBinary,
  coerceValue,
  convertValue,
  enumerationType,
  interfaceType,
  internalValue,
  isAggregateType,
  isCalendarType,
  isCharacterType,
  isIntegerType,
  isLongType,
  isWideCharacterType,
  ltimeBinary,
  parseCalendar,
  referenceLike,
  referenceType,
  sameScalarType,
  timeBinary,
  validateValue,
} from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import { rootName } from "../ast.js";
import type { ExpressionInfo } from "../checked.js";
import {
  binaryConstant,
  isConstantDeclaration,
  unaryConstant,
  withConstant,
} from "../constants.js";
import {
  acceptsKind,
  defaultType,
  exactConstant,
  exactNumber,
  isUntyped,
  materialize,
  timeLiteral,
} from "../exact.js";
import { binaryType, commonType, unaryType } from "../type-rules.js";

import type { CheckerContext } from "./context.js";
import { report } from "./context.js";
import { checkReference } from "./references.js";
import { baseType, isEnum, referenceAssignable } from "./type-identity.js";
import { resolveDescriptor } from "./types.js";

export function expression(
  ctx: CheckerContext,
  node: AST.Expression,
  expected?: TypeDescriptor,
): ExpressionInfo | null {
  const expectedBase = expected ? baseType(ctx, expected, ctx.types) : undefined;
  const cached = ctx.expressions.get(node);
  if (cached) return cached;
  let info: ExpressionInfo | null;
  if (isUntyped(node)) {
    try {
      const exact = exactConstant(node);
      const dataType =
        expectedBase && acceptsKind(expectedBase, exact) ? expectedBase : defaultType(exact);
      info = { dataType, constant: materialize(exact, dataType), untyped: true };
      ctx.expressions.set(node, info);
      return info;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      report(ctx, "type.invalid-constant", {}, node.span);
      return null;
    }
  }
  if (
    expected &&
    interfaceType(expected, ctx.types) &&
    ["name", "member", "field", "index", "dereference"].includes(node.kind)
  ) {
    const value = checkReference(ctx, node as AST.AssignmentTarget, false, true);
    if (
      value &&
      typeof value.descriptor === "object" &&
      value.descriptor.kind === "functionBlock"
    ) {
      const root = rootName(node as AST.AssignmentTarget);
      const declaration = (ctx.ast.owner?.declarations ?? [])
        .concat(ctx.ast.declarations)
        .find((d) => d.names.some((n) => n.key === root.key));
      if (
        node.kind !== "dereference" &&
        root.key !== "THIS" &&
        (!declaration ||
          isConstantDeclaration(declaration) ||
          ["VAR_TEMP", "VAR_IN_OUT"].includes(declaration.section ?? "") ||
          (ctx.ast.kind === "function" && !ctx.ast.owner && declaration.section !== "VAR_EXTERNAL"))
      ) {
        report(ctx, "interface.lifetime", {}, node.span);
        return null;
      }
      value.interfaceValue = expected;
      ctx.expressions.set(node, value);
      return value;
    }
  }
  switch (node.kind) {
    case "null":
      info = {
        dataType: "INT",
        descriptor:
          expected && referenceType(expected, ctx.types)
            ? expected
            : { kind: "reference", target: "BOOL" },
        nullReference: true,
      };
      break;
    case "dereference":
      info = checkReference(ctx, node);
      break;
    case "structureInitializer":
    case "arrayInitializer":
      report(ctx, "type.invalid-constant", {}, node.span);
      return null;
    case "literal":
      info = literalExpression(ctx, node, expectedBase);
      break;
    case "enumeration": {
      const type = resolveDescriptor(ctx, node.typeName);
      if (!type) {
        report(ctx, "decl.unknown-type", { name: node.typeName.name }, node.typeName.span);
        return null;
      }
      info = enumLiteral(ctx, node, type, node.member);
      break;
    }
    case "name":
      if (
        expected &&
        enumerationType(expected, ctx.types)?.values.some(
          (member) => member.name.toUpperCase() === node.name.key,
        )
      ) {
        if (ctx.names.has(node.name.key) || ctx.constants.has(node.name.key)) {
          report(ctx, "type.ambiguous-enumeration", { name: node.name.name }, node.span);
          return null;
        }
        info = enumLiteral(ctx, node, expected, node.name);
      } else info = checkReference(ctx, node);
      break;
    case "index":
    case "elementBit":
    case "field":
    case "member":
      info = checkReference(ctx, node);
      break;
    case "group":
      info = expression(ctx, node.expression, expected);
      break;
    case "functionCall":
      info = ctx.rules.functionCall(ctx, node, false, expected);
      break;
    case "unary":
      info = unaryExpression(ctx, node);
      break;
    case "binary":
      info = binaryExpression(ctx, node);
      break;
  }
  if (info) ctx.expressions.set(node, info);
  return info;
}

export function constant(
  ctx: CheckerContext,
  info: ExpressionInfo,
  node: AST.Expression,
  compute?: () => ScalarValue,
): ExpressionInfo {
  if (!compute) return info;
  try {
    return withConstant(info, compute());
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    report(ctx, "type.invalid-constant", {}, node.span);
    return info;
  }
}

export function operands(
  ctx: CheckerContext,
  nodes: AST.Expression[],
  independent = false,
  defaultExpected?: TypeDescriptor,
): (ExpressionInfo | null)[] {
  const deferred = (node: AST.Expression): boolean =>
    isUntyped(node) ||
    (node.kind === "literal" && node.literalKind === "string" && !node.dataType) ||
    (node.kind === "group" && deferred(node.expression)) ||
    (node.kind === "name" && !ctx.names.has(node.name.key) && !ctx.constants.has(node.name.key));
  const hint = (node: AST.Expression): TypeDescriptor | undefined => {
    if (node.kind === "group") return hint(node.expression);
    if (node.kind === "enumeration") return resolveDescriptor(ctx, node.typeName);
    if (node.kind === "name")
      return (
        ctx.names.get(node.name.key)?.descriptor ?? ctx.constants.get(node.name.key)?.descriptor
      );
    return undefined;
  };
  const context =
    defaultExpected && enumerationType(defaultExpected, ctx.types)
      ? defaultExpected
      : nodes.map(hint).find((type) => type && enumerationType(type, ctx.types));
  // A failed expression is null too; keep deferred operands separate so a
  // failed subtree is never checked again while selecting an enum context.
  const pending = new Set(nodes.flatMap((node, index) => (deferred(node) ? [index] : [])));
  const infos = nodes.map((node, index) =>
    pending.has(index) ? null : expression(ctx, node, context),
  );
  const enumeration = infos.find((info) => info && isEnum(ctx, info));
  const enumExpected =
    enumeration?.descriptor ??
    (defaultExpected && enumerationType(defaultExpected, ctx.types) ? defaultExpected : undefined);
  if (enumExpected)
    return nodes.map((node, index) => {
      if (
        node.kind === "name" &&
        (ctx.names.has(node.name.key) || ctx.constants.has(node.name.key)) &&
        enumerationType(enumExpected, ctx.types)?.values.some(
          (member) => member.name.toUpperCase() === node.name.key,
        )
      ) {
        report(ctx, "type.ambiguous-enumeration", { name: node.name.name }, node.span);
        return null;
      }
      return pending.has(index) ? expression(ctx, node, enumExpected) : infos[index]!;
    });
  independent = independent && (infos[0]?.dataType === "TIME" || infos[0]?.dataType === "LTIME");
  const common = commonType(infos.filter((info) => info !== null).map((info) => info.dataType));
  for (const index of pending) {
    const node = nodes[index]!;
    const characterLiteral = (value: AST.Expression): boolean =>
      value.kind === "group"
        ? characterLiteral(value.expression)
        : value.kind === "literal" && value.literalKind === "string" && !value.dataType;
    if (characterLiteral(node)) {
      infos[index] = expression(ctx, node);
      pending.delete(index);
      continue;
    }
    let useDefault = independent || !common || !isUntyped(node);
    try {
      if (!useDefault) useDefault = !acceptsKind(common!, exactConstant(node));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      useDefault = true;
    }
    if (useDefault) {
      infos[index] = expression(ctx, node, defaultExpected);
      pending.delete(index);
    }
  }
  for (const index of pending) infos[index] = expression(ctx, nodes[index]!, common ?? undefined);
  return infos;
}

export function enumLiteral(
  ctx: CheckerContext,
  node: AST.Expression,
  type: TypeDescriptor,
  name: AST.Identifier,
): ExpressionInfo | null {
  const enumeration = enumerationType(type, ctx.types);
  const member = enumeration?.values.find((member) => member.name.toUpperCase() === name.key);
  if (!member) {
    report(ctx, "name.undeclared", { name: name.name }, node.span);
    return null;
  }
  return { dataType: enumeration!.base, descriptor: type, constant: member.value };
}

function literalExpression(
  ctx: CheckerContext,
  node: Extract<AST.Expression, { kind: "literal" }>,
  expectedBase?: import("@benchtop-plc/core").DataType,
): ExpressionInfo | null {
  let info: ExpressionInfo | null;

  if (node.literalKind === "string") {
    const quote = node.text[node.dataType ? node.text.indexOf("#") + 1 : 0];
    const wide = quote === '"';
    const contextual =
      expectedBase && isCharacterType(expectedBase) && isWideCharacterType(expectedBase) === wide
        ? expectedBase
        : undefined;
    const dataType = node.dataType ?? contextual ?? (wide ? "WSTRING" : "STRING");
    try {
      if (!isCharacterType(dataType) || isWideCharacterType(dataType) !== wide)
        throw new RangeError("Mismatched literal delimiter");
      validateValue(dataType, node.value);
      info = { dataType, constant: node.value, untyped: !node.dataType };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      report(ctx, "type.invalid-constant", {}, node.span);
      return null;
    }
    return info;
  }
  const dataType = node.dataType ?? (node.literalKind === "boolean" ? "BOOL" : "TIME");
  try {
    const constant =
      node.literalKind === "calendar"
        ? parseCalendar(dataType as CalendarType, node.text)
        : node.literalKind === "time"
          ? timeLiteral(node.text)
          : node.literalKind === "boolean"
            ? coerceValue(dataType, node.value)
            : materialize(exactNumber(node.text.slice(node.text.indexOf("#") + 1)), dataType);
    info = { dataType, constant };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    report(ctx, "type.invalid-constant", {}, node.span);
    return null;
  }
  return info;
}

function unaryExpression(
  ctx: CheckerContext,
  node: Extract<AST.Expression, { kind: "unary" }>,
): ExpressionInfo | null {
  const operand = expression(ctx, node.operand);
  if (!operand) return null;
  const dataType =
    isEnum(ctx, operand) ||
    referenceLike(operand.descriptor ?? operand.dataType, ctx.types) ||
    (operand.descriptor && isAggregateType(operand.descriptor, ctx.types))
      ? null
      : unaryType(node.operator, operand.dataType);
  if (!dataType) {
    if (operand.nullReference) {
      report(ctx, "type.invalid-reference-target", {}, node.span);
      return null;
    }
    report(
      ctx,
      "type.operand-mismatch",
      { operator: node.operator, left: operand.descriptor ?? operand.dataType, right: null },
      node.span,
    );
    return null;
  }
  return constant(
    ctx,
    { dataType },
    node,
    operand.constant === undefined
      ? undefined
      : () => unaryConstant(node.operator, internalValue(operand.dataType, operand.constant!)),
  );
}

function binaryExpression(
  ctx: CheckerContext,
  node: Extract<AST.Expression, { kind: "binary" }>,
): ExpressionInfo | null {
  let info: ExpressionInfo | null;

  const scaling = (node.operator === "*" || node.operator === "/") && !isUntyped(node.left);
  const values =
    node.operator === "**"
      ? [
          expression(ctx, node.left, isUntyped(node.left) ? "LREAL" : undefined),
          expression(ctx, node.right),
        ]
      : operands(ctx, [node.left, node.right], scaling);
  const [left, right] = values;
  if (!left || !right) return null;
  const li = interfaceType(left.descriptor ?? left.dataType, ctx.types),
    ri = interfaceType(right.descriptor ?? right.dataType, ctx.types);
  if (li || ri) {
    if (
      !["=", "<>"].includes(node.operator) ||
      !(li || left.nullReference) ||
      !(ri || right.nullReference)
    ) {
      report(
        ctx,
        "type.operand-mismatch",
        {
          operator: node.operator,
          left: left.descriptor ?? left.dataType,
          right: right.descriptor ?? right.dataType,
        },
        node.span,
      );
      return null;
    }
    info = { dataType: "BOOL" };
    return info;
  }
  const lr = referenceType(left.descriptor ?? left.dataType, ctx.types),
    rr = referenceType(right.descriptor ?? right.dataType, ctx.types);
  if (lr || rr) {
    if (
      !lr ||
      !rr ||
      !["=", "<>"].includes(node.operator) ||
      (!left.nullReference &&
        !right.nullReference &&
        !(referenceAssignable(ctx, lr, rr) || referenceAssignable(ctx, rr, lr)))
    ) {
      if (left.nullReference || right.nullReference) {
        report(ctx, "type.invalid-reference-target", {}, node.span);
        return null;
      }
      report(
        ctx,
        "type.operand-mismatch",
        {
          operator: node.operator,
          left: left.descriptor ?? left.dataType,
          right: right.descriptor ?? right.dataType,
        },
        node.span,
      );
      return null;
    }
    info = { dataType: "BOOL" };
    return info;
  }
  const enums = isEnum(ctx, left) || isEnum(ctx, right);
  const dataType =
    (left.descriptor && isAggregateType(left.descriptor, ctx.types)) ||
    (right.descriptor && isAggregateType(right.descriptor, ctx.types))
      ? null
      : enums
        ? ["=", "<>"].includes(node.operator) &&
          sameScalarType(
            left.descriptor ?? left.dataType,
            right.descriptor ?? right.dataType,
            ctx.types,
          )
          ? "BOOL"
          : null
        : binaryType(node.operator, left.dataType, right.dataType);
  if (!dataType) {
    report(
      ctx,
      "type.operand-mismatch",
      {
        operator: node.operator,
        left: left.descriptor ?? left.dataType,
        right: right.descriptor ?? right.dataType,
      },
      node.span,
    );
    return null;
  }
  const common = node.operator === "**" ? null : commonType([left.dataType, right.dataType]);
  const constantOperand = (operand: ExpressionInfo): ScalarValue =>
    common && isLongType(common) && operand.dataType !== common
      ? internalValue(
          common,
          convertValue(`${operand.dataType}_TO_${common}` as ConversionFunction, operand.constant!),
        )
      : internalValue(operand.dataType, operand.constant!);
  info = constant(
    ctx,
    { dataType },
    node,
    left.constant === undefined || right.constant === undefined
      ? undefined
      : () =>
          isCalendarType(left.dataType)
            ? calendarBinary(
                node.operator,
                left.dataType,
                left.constant!,
                right.dataType,
                right.constant!,
              )
            : dataType === "LTIME"
              ? ltimeBinary(
                  node.operator as "+" | "-" | "*" | "/",
                  BigInt(constantOperand(left)),
                  right.dataType === "REAL" || right.dataType === "LREAL"
                    ? Number(right.constant!)
                    : BigInt(constantOperand(right)),
                  right.dataType,
                )
              : dataType === "TIME"
                ? timeBinary(
                    node.operator as "+" | "-" | "*" | "/",
                    Number(left.constant!),
                    typeof right.constant === "string" || typeof right.constant === "bigint"
                      ? BigInt(right.constant!)
                      : Number(right.constant!),
                    right.dataType,
                  )
                : node.operator === "*" && isIntegerType(dataType) && !isLongType(dataType)
                  ? Math.imul(Number(left.constant!), Number(right.constant!))
                  : binaryConstant(node.operator, constantOperand(left), constantOperand(right)),
  );
  return info;
}
