import {
  coerceValue,
  referenceType,
  cloneInitialValue,
  isAggregateType,
  leafCount,
  isFunctionBlockType,
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
import type { DataTypeDeclaration, Expression, Identifier, Subrange, TypeSyntax } from "./ast.js";
import { check, declarationType } from "./checker.js";
import { scalarTypes } from "./type-rules.js";

/** Resolve declarations before POU checking; forward aliases are allowed, cycles are not. */
export function resolveDataTypes(
  declarations: readonly DataTypeDeclaration[],
  blockIds: ReadonlyMap<string, number> = new Map(),
): {
  types: TypeTable;
  diagnostics: Diagnostic[];
} {
  // Indirection can name aggregate/reference types before their storage defaults resolve.
  const indirectTarget = (ast: DataTypeDeclaration, seen = new Set<string>()): boolean => {
    if (ast.members || ast.array || ast.reference) return true;
    if (
      !ast.typeName ||
      ast.reference ||
      ast.array ||
      ast.values ||
      ast.subrange ||
      ast.stringLength !== undefined ||
      seen.has(ast.name.key)
    )
      return false;
    seen.add(ast.name.key);
    const target = declarations.find((other) => other.name.key === ast.typeName!.key);
    return !!target && indirectTarget(target, seen);
  };
  const forwards = declarations.filter((ast) => indirectTarget(ast));
  const placeholders = new Set(forwards.map((ast) => ast.name.key));
  const failedCycles = new Set<string>();
  const types: TypeTable = forwards.map((ast) => ({
    name: ast.name.name,
    definition:
      ast.members || ast.array || ast.reference
        ? { kind: "structure", members: [] }
        : { kind: "alias", type: { kind: "named", name: ast.typeName!.name } },
    initialValue: [],
  }));
  const publish = (entry: TypeEntry): void => {
    const index = types.findIndex((type) => type.name.toUpperCase() === entry.name.toUpperCase());
    if (index < 0) types.push(entry);
    else types[index] = entry;
    placeholders.delete(entry.name.toUpperCase());
  };
  const diagnostics: Diagnostic[] = [];
  const pending = new Map(declarations.map((ast) => [ast.name.key, ast]));
  const visiting = new Set<string>();
  const unsupportedBlockArrayTypes = new Set<string>();
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
      result.checked?.symbols[0]?.aggregateValues ??
      (result.checked?.symbols[0]?.initialValue as InitialValue | undefined)
    );
  };
  const resolve = (ast: DataTypeDeclaration): TypeEntry | undefined => {
    if (failedCycles.has(ast.name.key)) return undefined;
    const existing = types.find((entry) => entry.name.toUpperCase() === ast.name.key);
    if (existing && !placeholders.has(ast.name.key)) return existing;
    if (unsupportedBlockArrayTypes.has(ast.name.key)) return undefined;
    if (visiting.has(ast.name.key)) {
      for (const name of visiting) failedCycles.add(name);
      report(ast, {
        code: "decl.type-cycle",
        severity: "error",
        span: ast.name.span,
        args: { name: ast.name.name },
      });
      return undefined;
    }
    visiting.add(ast.name.key);
    const resolveDependency = (other: DataTypeDeclaration): TypeEntry | undefined => {
      const entry = resolve(other);
      if (failedCycles.has(other.name.key)) failedCycles.add(ast.name.key);
      return entry;
    };
    if (ast.members) {
      const dependencies = (syntax: import("./ast.js").TypeSyntax, indirect = false): void => {
        if (syntax.reference) dependencies(syntax.reference, true);
        else if (syntax.array) dependencies(syntax.array, indirect);
        else {
          const other = pending.get(syntax.typeName.key);
          if (other && !(indirect && placeholders.has(other.name.key))) resolveDependency(other);
        }
      };
      for (const member of ast.members) dependencies(member);
      if (failedCycles.has(ast.name.key)) {
        visiting.delete(ast.name.key);
        return undefined;
      }
      const names = ast.members.flatMap((member) => member.names);
      const seen = new Set<string>();
      for (const name of names) {
        if (seen.has(name.key))
          report(ast, {
            code: "decl.duplicate",
            severity: "error",
            span: name.span,
            args: { name: name.name },
          });
        seen.add(name.key);
      }
      const functionBlockMembers = ast.members.flatMap((member) => {
        let syntax: TypeSyntax = member;
        while (syntax.array) syntax = syntax.array;
        if (syntax.reference) return [];
        const typeName = syntax.typeName;
        return isFunctionBlockType(typeName.key) || blockIds.has(typeName.key)
          ? [{ member, typeName }]
          : [];
      });
      for (const { member, typeName } of functionBlockMembers)
        report(ast, {
          code: "decl.structure-member-type",
          severity: "error",
          span: member.typeName.span,
          args: { name: typeName.name },
        });
      if (functionBlockMembers.length) {
        visiting.delete(ast.name.key);
        return undefined;
      }
      // Members have their own namespace. Reuse declaration checking with private
      // synthetic names so a member may have the same spelling as a data type.
      let prefix = "__STRUCT_MEMBER_";
      while (types.some((entry) => entry.name.toUpperCase().startsWith(prefix))) prefix += "_";
      let slot = 0;
      const declarations = ast.members.map((member) => ({
        ...member,
        names: member.names.map((name) => ({
          ...name,
          key: `${prefix}${slot++}`,
        })) as [Identifier, ...Identifier[]],
      }));
      const result = check(
        { kind: "program", name: ast.name, span: ast.span, body: [], declarations },
        new Map(),
        new Map(),
        new Map(),
        types,
      );
      diagnostics.push(...result.diagnostics.map((d) => ({ ...d, pou: ast.name.name })));
      if (
        !result.checked ||
        !ast.members.length ||
        ast.members.some((d) => d.address || d.constant) ||
        result.checked.symbols.some((symbol) => !symbol.descriptor)
      ) {
        if (result.checked)
          report(ast, {
            code: "type.invalid-constant",
            severity: "error",
            span: ast.span,
            args: {},
          });
        visiting.delete(ast.name.key);
        return undefined;
      }
      const members = result.checked.symbols.map((symbol, index) => ({
        name: names[index]!.name,
        dataType: symbol.descriptor!,
        initialValue: (symbol.aggregateValues ?? symbol.initialValue) as InitialValue,
      }));
      if (members.reduce((count, member) => count + leafCount(member.dataType, types), 0) > 10000) {
        report(ast, { code: "type.invalid-constant", severity: "error", span: ast.span, args: {} });
        visiting.delete(ast.name.key);
        return undefined;
      }
      const entry: TypeEntry = {
        name: ast.name.name,
        definition: { kind: "structure", members },
        initialValue: members.map((member) => cloneInitialValue(member.initialValue)),
      };
      publish(entry);
      if (ast.initializer) {
        const value = evaluate(ast, ast.initializer, { kind: "named", name: entry.name });
        if (value !== undefined) entry.initialValue = value;
      }
      visiting.delete(ast.name.key);
      return entry;
    }
    if (ast.reference) {
      const resolveTarget = (syntax: import("./ast.js").TypeSyntax): void => {
        if (syntax.reference) resolveTarget(syntax.reference);
        else if (syntax.array) resolveTarget(syntax.array);
        else {
          const other = pending.get(syntax.typeName.key);
          if (other && !placeholders.has(other.name.key)) resolveDependency(other);
        }
      };
      resolveTarget(ast.reference);
      if (failedCycles.has(ast.name.key)) {
        visiting.delete(ast.name.key);
        return undefined;
      }
      const result = check(
        {
          kind: "program",
          name: ast.name,
          span: ast.span,
          body: [],
          declarations: [
            {
              kind: "declaration",
              names: [{ name: "__REF_VALUE", key: "__REF_VALUE", span: ast.span }],
              typeName: ast.typeName!,
              reference: ast.reference,
              initializer: ast.initializer,
              span: ast.span,
            },
          ],
        },
        new Map(),
        new Map(),
        blockIds,
        types,
      );
      diagnostics.push(...result.diagnostics.map((d) => ({ ...d, pou: ast.name.name })));
      const symbol = result.checked?.symbols[0];
      visiting.delete(ast.name.key);
      if (!symbol?.descriptor) return undefined;
      const entry: TypeEntry = {
        name: ast.name.name,
        definition: { kind: "alias", type: symbol.descriptor },
        initialValue: null,
      };
      publish(entry);
      return entry;
    }
    let base: TypeDescriptor = "INT";
    if (ast.typeName) {
      const key = declarationType(ast.typeName.key);
      if (scalarTypes.some((type) => type === key)) base = key as (typeof scalarTypes)[number];
      else {
        const other = pending.get(key);
        const entry = other ? resolveDependency(other) : undefined;
        if (!entry) {
          if (failedCycles.has(ast.name.key)) {
            visiting.delete(ast.name.key);
            return undefined;
          }
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
        if (node.reference) {
          const target = (syntax: import("./ast.js").TypeSyntax): void => {
            if (syntax.reference) target(syntax.reference);
            else if (syntax.array) target(syntax.array);
            else {
              const other = pending.get(syntax.typeName.key);
              if (other && !placeholders.has(other.name.key)) resolveDependency(other);
            }
          };
          target(node.reference);
        } else if (node.array) resolveElements(node.array);
        else {
          const other = pending.get(node.typeName.key);
          if (other) resolveDependency(other);
        }
      };
      resolveElements(ast.array);
      if (failedCycles.has(ast.name.key)) {
        visiting.delete(ast.name.key);
        return undefined;
      }
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
        blockIds,
        types,
      );
      diagnostics.push(...result.diagnostics.map((d) => ({ ...d, pou: ast.name.name })));
      if (result.diagnostics.some((diagnostic) => diagnostic.code === "decl.fb-array-form"))
        unsupportedBlockArrayTypes.add(ast.name.key);
      const symbol = result.checked?.symbols[0];
      if (symbol && (isFunctionBlockType(symbol.type) || symbol.userBlock !== undefined)) {
        unsupportedBlockArrayTypes.add(ast.name.key);
        report(ast, {
          code: "decl.fb-array-form",
          severity: "error",
          span: ast.array.typeName.span,
          args: { form: "named" },
        });
        visiting.delete(ast.name.key);
        return undefined;
      }
      if (symbol?.descriptor && symbol.aggregateValues) {
        const entry: TypeEntry = {
          name: ast.name.name,
          definition: { kind: "alias", type: symbol.descriptor },
          initialValue: symbol.aggregateValues,
        };
        publish(entry);
        visiting.delete(ast.name.key);
        return entry;
      }
      visiting.delete(ast.name.key);
      return undefined;
    }
    if (referenceType(base, types)) {
      const entry: TypeEntry = {
        name: ast.name.name,
        definition: { kind: "alias", type: base },
        initialValue: null,
      };
      publish(entry);
      if (ast.initializer && ast.initializer.kind !== "null")
        report(ast, {
          code: "type.reference-initializer",
          severity: "error",
          span: ast.initializer.span,
          args: {},
        });
      visiting.delete(ast.name.key);
      return entry;
    }
    if (isAggregateType(base, types)) {
      const entry: TypeEntry = {
        name: ast.name.name,
        definition: { kind: "alias", type: base },
        initialValue: cloneInitialValue(
          typeEntry(base as import("@benchtop-plc/core").NamedType, types).initialValue,
        ),
      };
      publish(entry);
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
      publish(entry);
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
