import {
  coerceValue,
  cloneInitialValue,
  arrayType,
  type InitialValue,
  isCharacterType,
  DEFAULT_STRING_LENGTH,
  MAX_STRING_LENGTH,
  validateValue,
  isIntegerType,
  isLongType,
  scalarBase,
  typeEntry,
  type TypeDescriptor,
  type TypeEntry,
  type TypeTable,
  type Diagnostic,
  type ScalarValue,
} from "@benchtop-plc/core";
import type { DataTypeDeclaration, Expression, Identifier, Subrange } from "./ast.js";
import { check, declarationType } from "./checker.js";
import { scalarTypes } from "./type-rules.js";

/** Resolve declarations before POU checking; forward aliases are allowed, cycles are not. */
export function resolveDataTypes(declarations: readonly DataTypeDeclaration[]): {
  types: TypeTable;
  diagnostics: Diagnostic[];
} {
  const types: TypeTable = [];
  const diagnostics: Diagnostic[] = [];
  const pending = new Map(declarations.map((ast) => [ast.name.key, ast]));
  const visiting = new Set<string>();
  const report = (ast: DataTypeDeclaration, diagnostic: Diagnostic): void => {
    diagnostics.push({ ...diagnostic, pou: ast.name.name });
  };
  const evaluate = (
    ast: DataTypeDeclaration,
    expression: Expression,
    descriptor: TypeDescriptor,
  ): InitialValue | undefined => {
    let key = "__INITIAL_VALUE";
    while (declarations.some((declaration) => declaration.name.key === key)) key += "_";
    const name: Identifier = { name: key, key, span: expression.span };
    const typeName: Identifier = {
      name:
        typeof descriptor === "string"
          ? descriptor
          : descriptor.kind === "named"
            ? descriptor.name
            : descriptor.kind === "string" || descriptor.kind === "character"
              ? descriptor.base
              : "INT",
      key:
        typeof descriptor === "string"
          ? descriptor
          : descriptor.kind === "named"
            ? descriptor.name.toUpperCase()
            : descriptor.kind === "string" || descriptor.kind === "character"
              ? descriptor.base
              : "INT",
      span: expression.span,
    };
    const result = check(
      {
        kind: "program",
        name: ast.name,
        declarations: [
          {
            kind: "declaration",
            names: [name],
            typeName,
            ...(typeof descriptor !== "string" && descriptor.kind === "string"
              ? { stringLength: descriptor.length }
              : {}),
            initializer: expression,
            span: expression.span,
          },
        ],
        body: [],
        span: ast.span,
      },
      new Map(),
      new Map(),
      new Map(),
      types,
    );
    diagnostics.push(
      ...result.diagnostics.map((diagnostic) => ({ ...diagnostic, pou: ast.name.name })),
    );
    return (
      result.checked?.symbols[0]?.arrayValues ??
      (result.checked?.symbols[0]?.initialValue as InitialValue | undefined)
    );
  };
  const resolve = (ast: DataTypeDeclaration): TypeEntry | undefined => {
    const existing = types.find((entry) => entry.name.toUpperCase() === ast.name.key);
    if (existing) return existing;
    if (visiting.has(ast.name.key)) {
      report(ast, {
        code: "type.invalid-constant",
        severity: "error",
        span: ast.name.span,
        args: {},
      });
      return undefined;
    }
    visiting.add(ast.name.key);
    let base: TypeDescriptor = "INT";
    if (ast.typeName) {
      const key = declarationType(ast.typeName.key);
      if (scalarTypes.some((type) => type === key)) base = key as (typeof scalarTypes)[number];
      else {
        const other = pending.get(key);
        const entry = other ? resolve(other) : undefined;
        if (!entry) {
          report(ast, {
            code: "decl.unknown-type",
            severity: "error",
            span: ast.typeName.span,
            args: { name: ast.typeName.name },
          });
          visiting.delete(ast.name.key);
          return undefined;
        }
        base = { kind: "named", name: entry.name };
      }
    }
    if (
      ast.stringLength !== undefined &&
      !["STRING", "WSTRING"].includes(ast.typeName?.key ?? "")
    ) {
      report(ast, { code: "type.invalid-constant", severity: "error", span: ast.span, args: {} });
      visiting.delete(ast.name.key);
      return undefined;
    }
    if (ast.array) {
      const resolveElements = (node: import("./ast.js").ArrayDeclaration): void => {
        if (node.array) resolveElements(node.array);
        else {
          const other = pending.get(node.typeName.key);
          if (other) resolve(other);
        }
      };
      resolveElements(ast.array);
      const result = check(
        {
          kind: "program",
          name: ast.name,
          span: ast.span,
          body: [],
          declarations: [
            {
              kind: "declaration",
              names: [{ name: "__ARRAY_VALUE", key: "__ARRAY_VALUE", span: ast.span }],
              typeName: { name: "ARRAY", key: "ARRAY", span: ast.span },
              array: ast.array,
              initializer: ast.initializer,
              span: ast.span,
            },
          ],
        },
        new Map(),
        new Map(),
        new Map(),
        types,
      );
      diagnostics.push(...result.diagnostics.map((d) => ({ ...d, pou: ast.name.name })));
      const symbol = result.checked?.symbols[0];
      if (symbol?.descriptor && symbol.arrayValues) {
        const entry: TypeEntry = {
          name: ast.name.name,
          definition: { kind: "alias", type: symbol.descriptor },
          initialValue: symbol.arrayValues,
        };
        types.push(entry);
        visiting.delete(ast.name.key);
        return entry;
      }
      visiting.delete(ast.name.key);
      return undefined;
    }
    if (arrayType(base, types)) {
      const entry: TypeEntry = {
        name: ast.name.name,
        definition: { kind: "alias", type: base },
        initialValue: cloneInitialValue(
          typeEntry(base as import("@benchtop-plc/core").NamedType, types).initialValue,
        ),
      };
      types.push(entry);
      if (ast.initializer) {
        const value = evaluate(ast, ast.initializer, { kind: "named", name: entry.name });
        if (value !== undefined) entry.initialValue = value;
      }
      visiting.delete(ast.name.key);
      return entry;
    }
    const elementary = scalarBase(base, types);
    if (elementary === "STRING" || elementary === "WSTRING") {
      const length = ast.stringLength ?? DEFAULT_STRING_LENGTH;
      if (ast.stringLength !== undefined || typeof base === "string")
        base = { kind: "string", base: elementary, length };
      if (!Number.isInteger(length) || length < 1 || length > MAX_STRING_LENGTH) {
        report(ast, { code: "type.invalid-constant", severity: "error", span: ast.span, args: {} });
        visiting.delete(ast.name.key);
        return undefined;
      }
    } else if (ast.stringLength !== undefined) {
      report(ast, { code: "type.invalid-constant", severity: "error", span: ast.span, args: {} });
      visiting.delete(ast.name.key);
      return undefined;
    }
    let entry: TypeEntry | undefined;
    const invalid = (): void =>
      report(ast, { code: "type.invalid-constant", severity: "error", span: ast.span, args: {} });
    if (ast.values) {
      if (!isIntegerType(elementary)) invalid();
      else {
        const values: { name: string; value: number | string }[] = [];
        let next = 0n;
        for (const member of ast.values) {
          const value = member.value
            ? evaluate(ast, member.value, elementary)
            : isLongType(elementary)
              ? next.toString()
              : Number(next);
          if (value === undefined) continue;
          try {
            // Validate implicit increments too; they must not wrap at the base limit.
            validateValue(elementary, value);
            if (
              values.some(
                (item) =>
                  item.name.toUpperCase() === member.name.key ||
                  BigInt(item.value) === BigInt(value as ScalarValue),
              )
            )
              throw new RangeError("Duplicate enumeration member");
            values.push({
              name: member.name.name,
              value: coerceValue(elementary, value as ScalarValue),
            });
            next = BigInt(value as ScalarValue) + 1n;
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            invalid();
          }
        }
        if (!values.length) invalid();
        else
          entry = {
            name: ast.name.name,
            definition: { kind: "enumeration", base: elementary, values },
            initialValue: values[0]!.value,
          };
      }
    } else if (ast.subrange) {
      const range: Subrange = ast.subrange;
      const lower = evaluate(ast, range.lower, elementary),
        upper = evaluate(ast, range.upper, elementary);
      if (
        !isIntegerType(elementary) ||
        lower === undefined ||
        upper === undefined ||
        BigInt(lower as ScalarValue) > BigInt(upper as ScalarValue)
      )
        invalid();
      else
        entry = {
          name: ast.name.name,
          definition: {
            kind: "subrange",
            base: elementary,
            lower: coerceValue(elementary, lower as ScalarValue),
            upper: coerceValue(elementary, upper as ScalarValue),
          },
          initialValue: coerceValue(elementary, lower as ScalarValue),
        };
    } else if (ast.typeName) {
      const initialValue =
        typeof base !== "string" && base.kind === "named"
          ? typeEntry(base, types).initialValue
          : isCharacterType(elementary)
            ? elementary === "CHAR" || elementary === "WCHAR"
              ? "\0"
              : ""
            : elementary === "BOOL"
              ? false
              : isLongType(elementary)
                ? "0"
                : 0;
      entry = { name: ast.name.name, definition: { kind: "alias", type: base }, initialValue };
    } else invalid();
    if (entry) {
      types.push(entry);
      if (ast.initializer) {
        const value = evaluate(ast, ast.initializer, { kind: "named", name: entry.name });
        if (value !== undefined) entry.initialValue = coerceValue(elementary, value as ScalarValue);
      }
    }
    visiting.delete(ast.name.key);
    return entry;
  };
  for (const ast of declarations) resolve(ast);
  return {
    types: declarations.flatMap((ast) =>
      types.filter((entry) => entry.name.toUpperCase() === ast.name.key),
    ),
    diagnostics,
  };
}
