import type { ConversionFunction, TypeDescriptor } from "@benchtop-plc/core";
import {
  arrayType,
  conversionFunctions,
  convertValue,
  enumerationType,
  getStandardFunctionSignature as getSignature,
  internalValue,
  isAggregateType,
  isFunctionBlockType as isBlock,
  isCharacterType,
  isStandardFunction as isFunction,
  isIntegerType,
  isLongType,
  referenceLike,
  referenceType,
  sameScalarType,
} from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import { rootName } from "../ast.js";
import type { ExpressionInfo } from "../checked.js";
import { isConstantDeclaration, unaryConstant } from "../constants.js";
import { assignable, commonType, isNumeric, stringArgumentType } from "../type-rules.js";
import { operands } from "./expressions.js";

import { assignment } from "./assignment.js";
import type { CheckerContext } from "./context.js";
import { report } from "./context.js";
import { constant } from "./expressions.js";
import { checkReference, forControlWrite } from "./references.js";
import { aggregate, isEnum } from "./type-identity.js";
import { methodCall, userFunctionCall } from "./user-calls.js";

export function functionCall(
  ctx: CheckerContext,
  node: AST.FunctionCall,
  statement = false,
  expectedType?: TypeDescriptor,
): ExpressionInfo | null {
  if (node.name.key === "SUPER") {
    report(ctx, "inheritance.super-body", {}, node.span);
    return null;
  }
  if (node.name.key === "THIS") {
    report(ctx, "method.this-call", {}, node.span);
    return null;
  }
  const owner =
    ctx.ast.owner ?? (["functionBlock", "class"].includes(ctx.ast.kind) ? ctx.ast : undefined);
  if (node.receiver || owner?.methods?.some((m) => m.name.key === node.name.key))
    return methodCall(ctx, node, statement, owner);
  if (node.name.key === "REF") {
    if (statement) {
      report(ctx, "type.invalid-reference-target", {}, node.span);
      return null;
    }
    return referenceOf(ctx, node);
  }
  if (node.name.key === "LOWER_BOUND" || node.name.key === "UPPER_BOUND")
    return arrayBound(ctx, node);
  const pou = ctx.pous.get(node.name.key);
  if (pou?.kind === "program") {
    report(ctx, "call.program", { name: node.name.name }, node.name.span);
    return null;
  }
  if (pou?.kind === "function") return userFunctionCall(ctx, node, pou, statement);
  const symbol = ctx.names.get(node.name.key);
  if (symbol && (isBlock(symbol.type) || symbol.userBlock !== undefined)) {
    report(ctx, "fb.call-in-expression", { name: node.name.name }, node.span);
    return null;
  }
  if (!isFunction(node.name.key)) {
    node.args.forEach((arg) => ctx.rules.expression(ctx, arg));
    report(ctx, "call.unknown-function", { name: node.name.name }, node.name.span);
    return null;
  }
  return standardCall(ctx, node, node.name.key, expectedType);
}

interface StandardCall {
  node: AST.FunctionCall;
  name: import("@benchtop-plc/core").StandardFunction;
  signature: ReturnType<typeof getSignature>;
  inputs: AST.Expression[];
  enumContext?: TypeDescriptor;
  expectedType?: TypeDescriptor;
}
type Arguments = (ExpressionInfo | null)[];

function standardCall(
  ctx: CheckerContext,
  node: AST.FunctionCall,
  name: StandardCall["name"],
  expectedType?: TypeDescriptor,
): ExpressionInfo | null {
  ctx.functions.set(node, name);
  const call = prepareStandardCall(ctx, node, name, expectedType);
  if (!call) return null;
  const args = standardArguments(ctx, call);
  const reference =
    args.find(
      (arg) =>
        arg && !arg.nullReference && referenceLike(arg.descriptor ?? arg.dataType, ctx.types),
    ) ?? args.find((arg) => arg?.nullReference);
  if (reference) return referenceCall(ctx, call, args, reference);
  const aggregate = args.find(
    (arg) => arg?.descriptor && isAggregateType(arg.descriptor, ctx.types),
  );
  if (aggregate) return aggregateCall(ctx, call, args, aggregate);
  const enumeration = args.find((arg) => arg && isEnum(ctx, arg));
  if (enumeration) return enumerationCall(ctx, call, args, enumeration);
  return scalarCall(ctx, call, args);
}

function prepareStandardCall(
  ctx: CheckerContext,
  node: AST.FunctionCall,
  name: StandardCall["name"],
  expectedType?: TypeDescriptor,
): StandardCall | null {
  const signature = getSignature(name);
  const inputs = [...node.args];
  const invalidParameter = (parameter: AST.Identifier) =>
    report(
      ctx,
      "call.invalid-parameter",
      { name: node.name.name, parameter: parameter.name },
      parameter.span,
    );
  const enumContext =
    expectedType && enumerationType(expectedType, ctx.types) ? expectedType : undefined;
  // Preserve independent expression errors and the enclosing enum context on rejection.
  const rejectCall = (): null => {
    for (const argument of node.args) ctx.rules.expression(ctx, argument, enumContext);
    return null;
  };
  const seenOutputs = new Set<number>();
  for (const output of node.outputs ?? []) {
    const port = signature.outputs?.findIndex(([name]) => name === output.name.key) ?? -1;
    if (port < 0 || seenOutputs.has(port)) {
      invalidParameter(output.name);
      return rejectCall();
    }
    seenOutputs.add(port);
  }
  if (node.inputNames) {
    const ordered = new Map<number, AST.Expression>();
    let minimum = signature.min;
    for (const [index, parameter] of node.inputNames.entries()) {
      let port = signature.inputNames?.indexOf(parameter.key) ?? -1;
      if (port < 0 && signature.max === null) {
        const numbered = /^IN(0|[1-9][0-9]*)$/.exec(parameter.key);
        const last = /^IN([0-9]+)$/.exec(signature.inputNames?.at(-1) ?? "");
        if (
          numbered &&
          last &&
          Number.isSafeInteger(Number(numbered[1])) &&
          Number(numbered[1]) > Number(last[1])
        )
          port = signature.inputNames!.length - 1 + (Number(numbered[1]) - Number(last[1]));
      }
      if (port < 0 || !Number.isSafeInteger(port + 1) || ordered.has(port)) {
        invalidParameter(parameter);
        return rejectCall();
      }
      ordered.set(port, node.args[index]!);
      minimum = Math.max(minimum, port + 1);
    }
    // Check gaps before constructing the list, even for very large numbered inputs.
    if (ordered.size !== minimum) {
      report(
        ctx,
        "call.argument-count",
        { name: node.name.name, min: minimum, max: signature.max, found: ordered.size },
        node.span,
      );
      return rejectCall();
    }
    inputs.splice(
      0,
      inputs.length,
      ...Array.from({ length: ordered.size }, (_, index) => ordered.get(index)!),
    );
  }
  ctx.functionArguments.set(node, inputs);
  let validOutputs = true;
  for (const output of node.outputs ?? []) {
    const port = signature.outputs!.findIndex(([name]) => name === output.name.key);
    const target = checkReference(ctx, output.target, true);
    if (!target) {
      validOutputs = false;
      continue;
    }
    ctx.expressions.set(output.target, target);
    if (
      !assignment(
        ctx,
        target.descriptor ?? target.dataType,
        { dataType: signature.outputs![port]![1] },
        output.target.span,
      )
    )
      validOutputs = false;
  }
  if (!validOutputs) return rejectCall();
  if (
    !node.inputNames &&
    (inputs.length < signature.min || (signature.max !== null && inputs.length > signature.max))
  ) {
    report(
      ctx,
      "call.argument-count",
      { name: node.name.name, min: signature.min, max: signature.max, found: inputs.length },
      node.span,
    );
    return rejectCall();
  }
  return { node, name, signature, inputs, enumContext, expectedType };
}
function standardArguments(ctx: CheckerContext, call: StandardCall): Arguments {
  const { name, signature, inputs, enumContext } = call;
  const parameter = (arg: AST.Expression, index: number): ExpressionInfo | null => {
    const types = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
    return ctx.rules.expression(
      ctx,
      arg,
      name === "MOVE"
        ? enumContext
        : types.length === 1
          ? types[0]
          : types.every((type) => type === "REAL" || type === "LREAL")
            ? "LREAL"
            : undefined,
    );
  };
  const start = signature.genericStart;
  const realGroup =
    start !== undefined &&
    signature.arguments[start]?.every((type) => type === "REAL" || type === "LREAL");
  const inputArgs =
    start === undefined
      ? inputs.map(parameter)
      : [
          ...inputs.slice(0, start).map(parameter),
          ...operands(
            ctx,
            inputs.slice(start, signature.genericEnd),
            false,
            realGroup ? "LREAL" : enumContext,
          ),
          ...inputs
            .slice(signature.genericEnd ?? inputs.length)
            .map((arg, index) => parameter(arg, index + (signature.genericEnd ?? inputs.length))),
        ];
  return inputArgs.map((arg, index) => {
    if (!arg) return null;
    const accepted = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
    return { ...arg, dataType: stringArgumentType(arg.dataType, accepted) };
  });
}
function referenceCall(
  ctx: CheckerContext,
  call: StandardCall,
  args: Arguments,
  reference: ExpressionInfo,
): ExpressionInfo | null {
  const { node, name, signature, inputs, expectedType } = call;

  if (!["MOVE", "SEL", "MUX"].includes(name)) {
    report(ctx, "type.invalid-reference-target", {}, node.span);
    return null;
  }
  const firstValue = name === "MOVE" ? 0 : 1;
  if (reference.nullReference && args.slice(firstValue).some((arg) => arg && !arg.nullReference)) {
    report(ctx, "type.invalid-reference-target", {}, node.span);
    return null;
  }
  const descriptor =
    reference.nullReference && expectedType && referenceType(expectedType, ctx.types)
      ? expectedType
      : reference.descriptor!;
  let valid = args.every((arg) => arg !== null);
  args.forEach((arg, index) => {
    if (!arg) return;
    const expected = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
    const accepted =
      index >= firstValue
        ? arg.nullReference || sameScalarType(descriptor, arg.descriptor ?? arg.dataType, ctx.types)
        : !referenceLike(arg.descriptor ?? arg.dataType, ctx.types) &&
          !isAggregateType(arg.descriptor ?? arg.dataType, ctx.types) &&
          !isEnum(ctx, arg) &&
          expected.includes(arg.dataType);
    if (!accepted) {
      valid = false;
      if (arg.nullReference) report(ctx, "type.invalid-reference-target", {}, inputs[index]!.span);
      else
        report(
          ctx,
          "call.argument-type",
          {
            name,
            index,
            expected: index >= firstValue ? [descriptor] : expected,
            found: arg.descriptor ?? arg.dataType,
          },
          inputs[index]!.span,
        );
    }
  });
  if (!valid) return null;
  return {
    dataType: "INT",
    descriptor,
    ...(args.slice(firstValue).every((arg) => arg?.nullReference) ? { nullReference: true } : {}),
  };
}
function aggregateCall(
  ctx: CheckerContext,
  call: StandardCall,
  args: Arguments,
  aggregate: ExpressionInfo,
): ExpressionInfo | null {
  const { name, signature, inputs } = call;

  const firstValue = name === "SEL" || name === "MUX" ? 1 : 0;
  let valid = args.every((arg) => arg !== null);
  args.forEach((arg, index) => {
    if (!arg) return;
    const accepted =
      ["MOVE", "SEL", "MUX"].includes(name) && index >= firstValue
        ? sameScalarType(aggregate.descriptor!, arg.descriptor ?? arg.dataType, ctx.types)
        : !isAggregateType(arg.descriptor ?? arg.dataType, ctx.types) &&
          !isEnum(ctx, arg) &&
          signature.arguments[Math.min(index, signature.arguments.length - 1)]!.includes(
            arg.dataType,
          );
    if (!accepted) {
      valid = false;
      report(
        ctx,
        "call.argument-type",
        {
          name,
          index,
          expected: [aggregate.descriptor!],
          found: arg.descriptor ?? arg.dataType,
        },
        inputs[index]!.span,
      );
    }
  });
  if (!valid) return null;
  return ["MOVE", "SEL", "MUX"].includes(name)
    ? { dataType: "INT", descriptor: aggregate.descriptor }
    : null;
}
function enumerationCall(
  ctx: CheckerContext,
  call: StandardCall,
  args: Arguments,
  enumeration: ExpressionInfo,
): ExpressionInfo | null {
  const { name, signature, inputs } = call;

  const firstValue = name === "SEL" || name === "MUX" ? 1 : 0;
  let valid = args.every((arg) => arg !== null);
  args.forEach((arg, index) => {
    if (!arg) return;
    const enumValue = ["MOVE", "SEL", "MUX"].includes(name) && index >= firstValue;
    const expected = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
    const accepted = enumValue
      ? sameScalarType(enumeration.descriptor!, arg.descriptor ?? arg.dataType, ctx.types)
      : !isEnum(ctx, arg) && expected.includes(arg.dataType);
    if (!accepted) {
      valid = false;
      report(
        ctx,
        "call.argument-type",
        {
          name,
          index,
          expected: enumValue ? [enumeration.descriptor!] : expected,
          found: arg.descriptor ?? arg.dataType,
        },
        inputs[index]!.span,
      );
    }
  });
  if (!valid) return null;
  return ["MOVE", "SEL", "MUX"].includes(name)
    ? { dataType: enumeration.dataType, descriptor: enumeration.descriptor }
    : null;
}
function scalarCall(
  ctx: CheckerContext,
  call: StandardCall,
  args: Arguments,
): ExpressionInfo | null {
  const { node, name, signature, inputs } = call;
  const start = signature.genericStart;
  let validArguments = true;
  args.forEach((arg, index) => {
    if (!arg) {
      validArguments = false;
      return;
    }
    const expected = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
    // A fixed source parameter is a typed slot and accepts implicit widening.
    if (
      !expected.some((to) =>
        expected.length === 1 ? assignable(to, arg.dataType) : to === arg.dataType,
      )
    ) {
      validArguments = false;
      if (expected.length === 1 && isNumeric(expected[0]!) && isNumeric(arg.dataType))
        assignment(ctx, expected[0]!, arg, inputs[index]!.span);
      else
        report(
          ctx,
          "call.argument-type",
          { name: node.name.name, index, expected, found: arg.dataType },
          inputs[index]!.span,
        );
    }
  });
  if (signature.result && start === undefined) {
    if (!validArguments) return null;
    if (!Object.hasOwn(conversionFunctions, name)) return { dataType: signature.result };
    const arg = args[0];
    // Resolve overloaded conversions now, while the operand type is still available.
    const concrete = arg ? `${arg.dataType}_TO_${signature.result}` : name;
    const resolved =
      name.startsWith("TO_") && Object.hasOwn(conversionFunctions, concrete)
        ? (concrete as ConversionFunction)
        : (name as ConversionFunction);
    ctx.functions.set(node, resolved);
    if (
      resolved === "REAL_TO_DWORD" ||
      resolved === "DWORD_TO_REAL" ||
      resolved === "LREAL_TO_LWORD" ||
      resolved === "LWORD_TO_LREAL" ||
      ["BYTE_TO_BOOL", "WORD_TO_BOOL", "DWORD_TO_BOOL", "LWORD_TO_BOOL"].includes(resolved)
    ) {
      ctx.diagnostics.push({
        code: "type.portability",
        severity: "warning",
        args: { function: resolved },
        span: node.span,
        pou: ctx.ast.name.name,
      });
    }
    if (arg && (isCharacterType(arg.dataType) || isCharacterType(signature.result)))
      return { dataType: signature.result };
    return constant(
      ctx,
      { dataType: signature.result },
      node,
      arg?.constant === undefined || inputs.length !== 1
        ? undefined
        : () =>
            convertValue(
              resolved,
              signature.arguments[0]?.length === 1 &&
                signature.arguments[0][0] !== arg.dataType &&
                isLongType(signature.arguments[0][0]!)
                ? convertValue(
                    `${arg.dataType}_TO_${signature.arguments[0][0]}` as ConversionFunction,
                    arg.constant!,
                  )
                : arg.constant!,
            ),
    );
  }
  if (signature.resultArgument !== undefined) {
    const arg = args[signature.resultArgument];
    return arg && validArguments ? { dataType: arg.dataType } : null;
  }
  const values = args.flatMap((arg, index) =>
    arg && index >= (start ?? 0) && index < (signature.genericEnd ?? args.length)
      ? [{ ...arg, index }]
      : [],
  );
  const types = values.map((arg) => arg.dataType);
  const dataType = commonType(types);
  if (!dataType) {
    for (let offset = 1; offset < values.length; offset++) {
      // Recompute from each complete prefix, not a pairwise fold: common-type
      // selection is set-based and can change when a third type is added.
      const expected = commonType(types.slice(0, offset));
      const found = values[offset]!;
      if (expected && !commonType(types.slice(0, offset + 1))) {
        report(
          ctx,
          "call.argument-type",
          {
            name: node.name.name,
            index: found.index,
            expected: [expected],
            found: found.dataType,
          },
          inputs[found.index]!.span,
        );
        break;
      }
    }
  }
  if (dataType && validArguments && name === "NOT") {
    const operand = args[0]!;
    return constant(
      ctx,
      { dataType },
      node,
      operand.constant === undefined
        ? undefined
        : () => unaryConstant("NOT", internalValue(operand.dataType, operand.constant!)),
    );
  }
  return dataType && validArguments ? { dataType: signature.result ?? dataType } : null;
}
export function arrayBound(ctx: CheckerContext, node: AST.FunctionCall): ExpressionInfo | null {
  if (node.args.length !== 2) {
    report(
      ctx,
      "call.argument-count",
      { name: node.name.name, min: 2, max: 2, found: node.args.length },
      node.span,
    );
    return null;
  }
  const args = node.inputNames
    ? [
        node.args[node.inputNames.findIndex((n) => n.key === "IN")],
        node.args[node.inputNames.findIndex((n) => n.key === "DIM")],
      ]
    : node.args;
  for (const parameter of [...(node.inputNames ?? []), ...(node.outputs ?? []).map((o) => o.name)])
    if (!["IN", "DIM"].includes(parameter.key) || node.outputs?.some((o) => o.name === parameter))
      report(
        ctx,
        "call.invalid-parameter",
        { name: node.name.name, parameter: parameter.name },
        parameter.span,
      );
  const [value, dim] = args;
  if (!value || !dim) {
    report(
      ctx,
      "call.invalid-parameter",
      { name: node.name.name, parameter: node.name.name },
      node.span,
    );
    return null;
  }
  const info = ctx.rules.expression(ctx, value);
  const dimension = ctx.rules.expression(ctx, dim);
  const type = info?.descriptor ?? info?.dataType;
  const array = type && arrayType(type, ctx.types);
  if (!array) {
    if (type) report(ctx, "type.not-array", { type }, value.span);
    return null;
  }
  if (
    !dimension ||
    !isIntegerType(dimension.dataType) ||
    isEnum(ctx, dimension) ||
    aggregate(ctx, dimension) ||
    dimension.constant === undefined ||
    BigInt(dimension.constant) < 1n ||
    BigInt(dimension.constant) > BigInt(array.dimensions.length)
  ) {
    report(ctx, "type.invalid-constant", {}, dim.span);
    return null;
  }
  ctx.arrayBounds.set(node, {
    array: value,
    dimension: Number(dimension.constant) - 1,
    upper: node.name.key === "UPPER_BOUND",
  });
  return { dataType: "DINT" };
}

export function referenceOf(ctx: CheckerContext, node: AST.FunctionCall): ExpressionInfo | null {
  const invalid = (): null => {
    report(ctx, "type.invalid-reference-target", {}, node.span);
    return null;
  };
  if (node.args.length !== 1 || node.inputNames || node.outputs) return invalid();
  const target = node.args[0]!;
  if (!["name", "member", "field", "index"].includes(target.kind)) return invalid();
  const access = target as AST.AssignmentTarget;
  const noDereference = (value: AST.AssignmentTarget): boolean =>
    value.kind === "dereference"
      ? false
      : value.kind === "index"
        ? noDereference(value.array)
        : value.kind === "field"
          ? noDereference(value.object)
          : true;
  if (!noDereference(access)) return invalid();
  let root = access;
  while (root.kind === "field" || root.kind === "index")
    root = root.kind === "field" ? root.object : root.array;
  const name =
    root.kind === "member" && root.instance.key === "THIS" ? root.member : rootName(root);
  const symbol = ctx.names.get(name.key);
  if (symbol && forControlWrite(ctx, symbol, name)) return null;
  const declaration = (ctx.ast.owner?.declarations ?? [])
    .concat(ctx.ast.declarations)
    .find((d) => d.names.some((n) => n.key === name.key));
  const owner =
    ctx.ast.owner ?? (["class", "functionBlock"].includes(ctx.ast.kind) ? ctx.ast : undefined);
  if (
    !(name.key === "THIS" && owner) &&
    (!declaration ||
      isConstantDeclaration(declaration) ||
      declaration.section === "VAR_TEMP" ||
      declaration.section === "VAR_IN_OUT" ||
      (ctx.ast.kind === "function" && ctx.ast.declarations.includes(declaration)))
  )
    return invalid();
  const info = checkReference(ctx, access, false, true);
  if (!info) return null;
  const selector =
    access.kind === "member" || access.kind === "field"
      ? ctx.references.get(access.member)
      : undefined;
  if (selector?.bit !== undefined) return invalid();
  const type = info.descriptor ?? info.dataType;
  if (typeof type !== "string" && type.kind === "functionBlock" && !ctx.blockIds.has(type.name))
    return invalid();
  ctx.expressions.set(access, info);
  return { dataType: "INT", descriptor: { kind: "reference", target: type } };
}
