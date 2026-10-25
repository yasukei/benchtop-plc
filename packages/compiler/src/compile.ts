import { resolveInterfaces, checkInterfaces } from "./interfaces.js";
import { resolveInheritance, checkOverrides, derivesFrom } from "./inheritance.js";
import { outputOverlapWarnings } from "./direct-addresses.js";
import { checkTasks } from "./tasks.js";
import { checkProgramConnections } from "./program-connections.js";
import {
  parseConfiguration,
  checkConfiguration,
  type ImplicitConfiguration,
} from "./configuration.js";
import { isReservedStandardName } from "./reserved-names.js";
import { isFunctionBlockType, isStandardFunction, leafCount } from "@benchtop-plc/core";
import type { Diagnostic, ConfigurationIR } from "@benchtop-plc/core";
import type { Program } from "./ast.js";
import type { CheckedProgram, VariableSymbol, GlobalScope } from "./checked.js";
import { check, checkDeclarations } from "./checker.js";
import { lower, lowerFunction, lowerFunctionBlock } from "./lower.js";
import { blockVariant } from "./overloaded-blocks.js";
import { arrayType } from "@benchtop-plc/core";
import { isElementaryTypeName } from "./lexer.js";
import { resolveDataTypes } from "./data-types.js";
import { parseDataType, parsePou } from "./parser.js";

/** Source order identifies a POU even when its header is missing or its name is duplicated. */
export type CompileDiagnostic = Diagnostic & {
  sourceIndex?: number;
  sourceKind?: "dataType" | "pou" | "configuration";
};
export type CompileResult =
  | { ir: ConfigurationIR; diagnostics: CompileDiagnostic[] }
  | { ir?: never; diagnostics: CompileDiagnostic[] };

/** Compatibility entry point for the single-program editor and project codec. */
export function compile(source: string): CompileResult {
  const result = compileProject([source]);
  // Preserve the legacy single-source diagnostic shape for existing callers.
  return {
    ...result,
    diagnostics: result.diagnostics.map((diagnostic) => {
      const legacy = { ...diagnostic };
      delete legacy.sourceIndex;
      return legacy;
    }),
  };
}

/** Compile an ordered list of sources, each containing exactly one POU. */
export function compileProject(
  sources: readonly string[],
  dataTypeSources: readonly string[] = [],
  configurationSource?: string,
  implicit: ImplicitConfiguration = {},
): CompileResult {
  const diagnostics: CompileDiagnostic[] = [];
  const configDiagnostic = (diagnostic: Diagnostic): CompileDiagnostic => ({
    ...diagnostic,
    sourceKind: "configuration",
    sourceIndex: 0,
  });
  const parsedConfig =
    configurationSource === undefined ? undefined : parseConfiguration(configurationSource);
  diagnostics.push(...(parsedConfig?.diagnostics.map(configDiagnostic) ?? []));
  const dataTypes: import("./ast.js").DataTypeDeclaration[] = [];
  const typeIndexes = new Map<string, number>();
  for (const [sourceIndex, source] of dataTypeSources.entries()) {
    const parsed = parseDataType(source);
    diagnostics.push(
      ...parsed.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        sourceIndex,
        sourceKind: "dataType" as const,
      })),
    );
    if (parsed.ast) {
      const ast = parsed.ast;
      if (typeIndexes.has(ast.name.key))
        diagnostics.push({
          code: "decl.duplicate",
          severity: "error",
          pou: ast.name.name,
          sourceIndex,
          sourceKind: "dataType",
          span: ast.name.span,
          args: { name: ast.name.name },
        });
      else {
        dataTypes.push(ast);
        typeIndexes.set(ast.name.key, sourceIndex);
      }
    }
  }
  const sourceIndexes = new Map<Program, number>();
  const asts: Program[] = [];
  for (const [sourceIndex, source] of sources.entries()) {
    const parsed = parsePou(source);
    diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, sourceIndex })));
    if (parsed.ast) {
      asts.push(parsed.ast);
      sourceIndexes.set(parsed.ast, sourceIndex);
    }
  }
  // A damaged header cannot reliably participate in project-wide name/count checks.
  if (asts.length !== sources.length) return { diagnostics };
  const pous = new Map<string, Program>();
  for (const ast of asts) {
    const name = ast.name;
    if (pous.has(name.key))
      diagnostics.push({
        code: "pou.duplicate",
        severity: "error",
        pou: name.name,
        sourceIndex: sourceIndexes.get(ast),
        span: name.span,
        args: { name: name.name },
      });
    else pous.set(name.key, ast);
    if (
      isElementaryTypeName(name.key) ||
      isStandardFunction(name.key) ||
      isReservedStandardName(name.key) ||
      isFunctionBlockType(name.key)
    )
      diagnostics.push({
        code: "pou.name-collision",
        severity: "error",
        pou: name.name,
        sourceIndex: sourceIndexes.get(ast),
        span: name.span,
        args: { name: name.name },
      });
  }
  for (const ast of dataTypes) {
    if (
      pous.has(ast.name.key) ||
      isElementaryTypeName(ast.name.key) ||
      isStandardFunction(ast.name.key) ||
      isReservedStandardName(ast.name.key) ||
      isFunctionBlockType(ast.name.key)
    )
      diagnostics.push({
        code: "decl.name-collision",
        severity: "error",
        pou: ast.name.name,
        sourceIndex: typeIndexes.get(ast.name.key),
        sourceKind: "dataType",
        span: ast.name.span,
        args: { name: ast.name.name, kind: "type" },
      });
  }
  if (dataTypeSources.length && diagnostics.some((diagnostic) => diagnostic.severity === "error"))
    return { diagnostics };
  const blocks = asts.filter((ast) => ast.kind === "functionBlock" || ast.kind === "class");
  const blockIds = new Map(blocks.map((ast, index) => [ast.name.key, index]));
  const inheritanceDiagnostics = resolveInheritance(blocks, pous);
  diagnostics.push(
    ...inheritanceDiagnostics.map((diagnostic) => ({
      ...diagnostic,
      sourceIndex: sourceIndexes.get(pous.get(diagnostic.pou!.toUpperCase())!),
    })),
  );
  if (inheritanceDiagnostics.length) return { diagnostics };
  const interfaceAsts = asts.filter((ast) => ast.kind === "interface");
  const prototypeOwners = new Map(
    interfaceAsts.flatMap((owner) =>
      (owner.methods ?? []).map((method) => [method, owner] as const),
    ),
  );
  for (const [method, owner] of prototypeOwners)
    sourceIndexes.set(method, sourceIndexes.get(owner)!);
  const interfaceGraph = resolveInterfaces(interfaceAsts, pous);
  diagnostics.push(
    ...interfaceGraph.diagnostics.map((d) => ({
      ...d,
      sourceIndex: sourceIndexes.get(pous.get(d.pou!.toUpperCase())!),
    })),
  );
  if (interfaceGraph.diagnostics.length) return { diagnostics };
  const resolved = resolveDataTypes(dataTypes, blockIds, interfaceGraph.types);
  diagnostics.push(
    ...resolved.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      sourceIndex: diagnostic.pou ? typeIndexes.get(diagnostic.pou.toUpperCase()) : undefined,
      sourceKind: "dataType" as const,
    })),
  );
  if (resolved.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
    return { diagnostics };
  const programs = asts.filter((ast) => ast.kind === "program");
  if (parsedConfig?.ast)
    diagnostics.push(
      ...checkConfiguration(parsedConfig.ast, pous, typeIndexes.keys()).map(configDiagnostic),
    );
  if (configurationSource === undefined && programs.length !== 1)
    diagnostics.push({
      code: "pou.program-count",
      severity: "error",
      args: { found: programs.length },
    });
  const functions = asts.filter((ast) => ast.kind === "function");
  const functionIds = new Map(functions.map((ast, index) => [ast.name.key, index]));
  const config = parsedConfig?.ast;
  let globals: CheckedProgram | undefined;
  if (config) {
    const ast: Program = {
      kind: "program",
      name: config.name,
      span: config.span,
      declarations: [...config.globals, ...config.resourceGlobals],
      body: [],
    };
    const result = check(ast, pous, functionIds, blockIds, resolved.types);
    diagnostics.push(...result.diagnostics.map(configDiagnostic));
    // External bindings require a valid global scope; avoid misleading lookup errors
    // in every importing POU when a global declaration is invalid.
    if (!result.checked) return { diagnostics };
    globals = result.checked;
  }
  const scope: GlobalScope | undefined =
    globals || blocks.some((block) => block.methods?.length)
      ? {
          symbols: globals?.symbols ?? [],
          constants: globals?.constants ?? new Map(),
          bindings: new Map(),
          memberBindings: new Map(),
        }
      : undefined;
  const methods = [...new Set(blocks.flatMap((owner) => owner.methods ?? []))];
  for (const method of methods) sourceIndexes.set(method, sourceIndexes.get(method.owner!)!);
  const prototypes = [...prototypeOwners.keys()];
  const allBodies = [...asts.filter((ast) => ast.kind !== "interface"), ...methods];
  const interfaces = new Map<Program, CheckedProgram>();
  for (const ast of new Set([...allBodies, ...prototypes])) {
    const result = checkDeclarations(ast, resolved.types, pous, blockIds, scope);
    const owner = prototypeOwners.get(ast);
    if (owner)
      diagnostics.push(
        ...result.diagnostics.map((d) => ({
          ...d,
          pou: `${owner.name.name}.${ast.name.name}`,
          sourceIndex: sourceIndexes.get(ast),
        })),
      );

    if (result.checked) interfaces.set(ast, result.checked);
  }
  diagnostics.push(
    ...checkOverrides(blocks, interfaces).map((diagnostic) => ({
      ...diagnostic,
      sourceIndex: sourceIndexes.get(pous.get(diagnostic.pou!.toUpperCase())!),
    })),
  );
  diagnostics.push(
    ...checkInterfaces(blocks, pous, interfaces, interfaceGraph.conflicts).map((d) => ({
      ...d,
      sourceIndex: sourceIndexes.get(pous.get(d.pou!.toUpperCase())!),
    })),
  );
  // Discover overload bindings before selecting shared global and instance FB variants.
  if (scope)
    for (const ast of allBodies)
      check(ast, pous, functionIds, blockIds, resolved.types, interfaces, scope);
  const checked = new Map<Program, CheckedProgram>();
  for (const ast of allBodies) {
    const result = check(ast, pous, functionIds, blockIds, resolved.types, interfaces, scope);
    diagnostics.push(
      ...result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        sourceIndex: sourceIndexes.get(ast),
      })),
    );
    if (result.checked) checked.set(ast, result.checked);
  }
  if (
    checked.size !== allBodies.length ||
    diagnostics.some((diagnostic) => diagnostic.severity === "error")
  )
    return { diagnostics };
  // Reject a back edge at its call site, including cycles unreachable from the PROGRAM.
  const visiting = new Set<Program>(),
    visited = new Set<Program>();
  const visit = (ast: Program): void => {
    if (visited.has(ast)) return;
    visiting.add(ast);
    const edges = [
      ...[...checked.get(ast)!.userCalls].flatMap(([node, call]) => {
        if (!call.method) return [{ node, callee: functions[call.function]! }];
        if (call.method.interface) {
          const prototype = pous.get(call.method.interface)!.methods![call.function]!;
          return [
            ...new Set(
              blocks
                .filter((b) => b.implemented?.includes(call.method!.interface!))
                .flatMap(
                  (b) =>
                    b.methods?.filter((m) => m.name.key === prototype.name.key && !m.abstract) ??
                    [],
                ),
            ),
          ].map((callee) => ({ node, callee }));
        }
        const target = blocks[call.method.block]!;
        const targets =
          !call.method.receiver && !call.method.static
            ? blocks.filter((block) => derivesFrom(block, target))
            : [target];
        return [...new Set(targets.map((block) => block.methods![call.function]!))].map(
          (callee) => ({ node, callee }),
        );
      }),
      ...[...checked.get(ast)!.superCalls].map(([node, block]) => ({
        node,
        callee: blocks[block]!,
      })),
      ...(ast.bodyOwner ? [{ node: ast, callee: ast.bodyOwner }] : []),
      ...[...checked.get(ast)!.blockCalls].map(([node, block]) => ({
        node,
        callee: blocks[block]!,
      })),
      ...ast.declarations
        .filter((node) => node.section !== "VAR_EXTERNAL")
        .flatMap((node) => {
          const callee = pous.get((node.array?.typeName ?? node.typeName).key);
          return callee?.kind === "functionBlock" || callee?.kind === "class"
            ? [{ node, callee }]
            : [];
        }),
    ];
    for (const { node, callee } of edges) {
      if (visiting.has(callee))
        diagnostics.push({
          code: "pou.recursion",
          severity: "error",
          pou: ast.name.name,
          sourceIndex: sourceIndexes.get(ast),
          span: node.span,
          args: { name: callee.name.name },
        });
      else visit(callee);
    }
    visiting.delete(ast);
    visited.add(ast);
  };
  for (const ast of allBodies) visit(ast);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { diagnostics };
  // Instance-array limits include every monitored member, not just the instance slots.
  const blockLeafCounts = new Map<number, number>();
  const variableLeaves = (symbol: VariableSymbol): number =>
    (symbol.descriptor ? leafCount(symbol.descriptor, resolved.types) : 1) *
    (symbol.userBlock === undefined ? 1 : blockLeaves(symbol.userBlock));
  const blockLeaves = (block: number): number => {
    const cached = blockLeafCounts.get(block);
    if (cached !== undefined) return cached;
    const definition = checked.get(blocks[block]!)!;
    const count = definition.ast.declarations
      .filter(
        (declaration) =>
          !declaration.constant &&
          declaration.section !== "VAR_TEMP" &&
          declaration.section !== "VAR_IN_OUT" &&
          declaration.section !== "VAR_EXTERNAL",
      )
      .flatMap((declaration) => declaration.names)
      .reduce(
        (sum, name) =>
          sum + variableLeaves(definition.symbols[definition.references.get(name)!.variable]!),
        0,
      );
    blockLeafCounts.set(block, count);
    return count;
  };
  for (const definition of [...checked.values(), ...(globals ? [globals] : [])]) {
    const ast = definition.ast;
    for (const symbol of definition.symbols) {
      if (symbol.userBlock !== undefined && symbol.descriptor && variableLeaves(symbol) > 10000)
        diagnostics.push({
          code: "type.invalid-constant",
          severity: "error",
          pou: ast.name.name,
          sourceIndex: sourceIndexes.get(ast),
          ...(definition === globals
            ? { sourceKind: "configuration" as const, sourceIndex: 0 }
            : {}),
          span: symbol.name.span,
          args: {},
        });
    }
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { diagnostics };
  if (scope)
    for (const symbol of scope.symbols) {
      const variant = blockVariant(symbol.type, scope.bindings.get(symbol.name.key) ?? []);
      if (variant) {
        symbol.type = variant;
        const array = symbol.descriptor && arrayType(symbol.descriptor, resolved.types);
        if (array)
          symbol.descriptor = { ...array, element: { kind: "functionBlock", name: variant } };
      }
    }
  const tasks = config && globals ? checkTasks(config, globals) : undefined;
  diagnostics.push(...(tasks?.diagnostics.map(configDiagnostic) ?? []));
  const connections =
    config && globals
      ? checkProgramConnections(
          config,
          new Map(programs.map((ast) => [ast.name.key, checked.get(ast)!])),
          globals,
        )
      : undefined;
  diagnostics.push(...(connections?.diagnostics.map(configDiagnostic) ?? []));
  if (diagnostics.some((d) => d.severity === "error")) return { diagnostics };
  const ir = lower(
    programs.map((ast) => checked.get(ast)!),
    config
      ? {
          name: config.name.name,
          resource: config.resource.name,
          tasks: tasks!.tasks,
          programs: config.programs.map((instance) => ({
            name: instance.name.name,
            program: programs.findIndex((ast) => ast.name.key === instance.type.key),
            task: config.tasks.findIndex((task) => task.name.key === instance.task?.key),
          })),
          explicit: true,
          span: config.span,
        }
      : {
          name: implicit.name ?? "Config",
          resource: implicit.resource ?? "Res",
          tasks: [{ name: "Cyclic", intervalMs: 10, priority: 1, ...implicit.task }],
          programs: [{ name: implicit.instance ?? "mainInstance", program: 0, task: 0 }],
          explicit: false,
          span: programs[0]!.span,
        },
    blocks.map((ast) => ({
      ...lowerFunctionBlock(checked.get(ast)!),
      ...(ast.implemented?.length ? { interfaces: ast.implemented } : {}),
      ...(ast.baseType ? { base: blockIds.get(ast.baseType.name.key)! } : {}),
      ...(ast.bodyOwner ? { bodyOwner: blockIds.get(ast.bodyOwner.name.key)! } : {}),
      ...(ast.abstract ? { abstract: true as const } : {}),
      ...(ast.final ? { final: true as const } : {}),
      ...(ast.methods?.length
        ? {
            methods: ast.methods.map((method) => ({
              ...lowerFunction(checked.get(method)!),
              memberCount: checked.get(method)!.memberCount!,
              declaringType: blockIds.get(method.owner!.name.key)!,
              ...(method.abstract ? { abstract: true as const } : {}),
              ...(method.final ? { final: true as const } : {}),
            })),
            methodTable: Object.fromEntries(ast.methods.map((m, i) => [m.name.key, i])),
          }
        : {}),
    })),
    globals,
    connections?.connections,
  );
  if (interfaceAsts.length)
    ir.interfaces = interfaceAsts.map((ast) => ({
      name: ast.name.key,
      extends: ast.implemented ?? [],
      methods: ast.methods!.map((method) => lowerFunction(interfaces.get(method)!)),
    }));
  for (const block of ir.functionBlocks ?? [])
    if (block.bodyOwner !== undefined) block.body = ir.functionBlocks![block.bodyOwner]!.body;
  if (functions.length) ir.functions = functions.map((ast) => lowerFunction(checked.get(ast)!));
  diagnostics.push(
    ...outputOverlapWarnings(ir).map((diagnostic) =>
      diagnostic.pou === ir.name
        ? configDiagnostic(diagnostic)
        : {
            ...diagnostic,
            sourceIndex: sourceIndexes.get(programs.find((p) => p.name.name === diagnostic.pou)!),
          },
    ),
  );
  return { ir, diagnostics };
}
