import {
  coerceValue,
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
  ): ScalarValue | undefined => {
    let key = "__INITIAL_VALUE";
    while (declarations.some((declaration) => declaration.name.key === key)) key += "_";
    const name: Identifier = { name: key, key, span: expression.span };
    const typeName: Identifier = {
      name:
        typeof descriptor === "string"
          ? descriptor
          : descriptor.kind === "named"
            ? descriptor.name
            : "INT",
      key:
        typeof descriptor === "string"
          ? descriptor
          : descriptor.kind === "named"
            ? descriptor.name.toUpperCase()
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
    return result.checked?.symbols[0]?.initialValue ?? undefined;
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
    const elementary = scalarBase(base, types);
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
                  BigInt(item.value) === BigInt(value),
              )
            )
              throw new RangeError("Duplicate enumeration member");
            values.push({ name: member.name.name, value: coerceValue(elementary, value) });
            next = BigInt(value) + 1n;
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
        BigInt(lower) > BigInt(upper)
      )
        invalid();
      else
        entry = {
          name: ast.name.name,
          definition: {
            kind: "subrange",
            base: elementary,
            lower: coerceValue(elementary, lower),
            upper: coerceValue(elementary, upper),
          },
          initialValue: coerceValue(elementary, lower),
        };
    } else if (ast.typeName) {
      const initialValue =
        typeof base !== "string" && base.kind === "named"
          ? typeEntry(base, types).initialValue
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
        if (value !== undefined) entry.initialValue = coerceValue(elementary, value);
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
