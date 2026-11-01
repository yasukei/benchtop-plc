import type {
  DataType,
  Diagnostic,
  DiagnosticArgs,
  DiagnosticCode,
  SourceSpan,
  StandardFunction,
  TypeDescriptor,
  TypeTable,
} from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import type {
  CheckedProgram,
  ConstantSymbol,
  ExpressionInfo,
  GlobalScope,
  ResolvedReference,
  UserCallInfo,
  VariableSymbol,
} from "../checked.js";

export type CheckResult =
  | { checked: CheckedProgram; diagnostics: Diagnostic[] }
  | { checked: null; diagnostics: Diagnostic[] };

export interface CheckerInputs {
  ast: AST.Program;
  pous: ReadonlyMap<string, AST.Program>;
  functionIds: ReadonlyMap<string, number>;
  blockIds: ReadonlyMap<string, number>;
  types: TypeTable;
  interfaces: ReadonlyMap<AST.Program, CheckedProgram>;
  globals?: GlobalScope;
}

/** Recursive edges are wired at the entry point, keeping rule modules acyclic. */
export interface RecursiveChecks {
  expression(
    ctx: CheckerContext,
    node: AST.Expression,
    expected?: TypeDescriptor,
  ): ExpressionInfo | null;
  functionCall(
    ctx: CheckerContext,
    node: AST.FunctionCall,
    statement?: boolean,
    expected?: TypeDescriptor,
  ): ExpressionInfo | null;
  createContext(inputs: CheckerInputs): CheckerContext;
  declarations(inputs: CheckerInputs): CheckResult;
}

/** One checking session owns its side tables; scoped views share them explicitly. */
export class CheckerContext implements CheckerInputs {
  readonly ast: AST.Program;
  readonly pous: ReadonlyMap<string, AST.Program>;
  readonly functionIds: ReadonlyMap<string, number>;
  readonly blockIds: ReadonlyMap<string, number>;
  readonly types: TypeTable;
  readonly interfaces: ReadonlyMap<AST.Program, CheckedProgram>;
  readonly globals?: GlobalScope;
  readonly declarationScope?: { owner?: AST.Program; initializerOwner?: AST.Program };
  readonly state: {
    inheritedDeclarationError: boolean;
    result?: VariableSymbol;
    resultMayBeAssigned: boolean;
    collectingDeclarations: boolean;
  } = {
    inheritedDeclarationError: false,
    resultMayBeAssigned: false,
    collectingDeclarations: true,
  };
  readonly superCalls = new Map<AST.FunctionCall | AST.FunctionBlockCall, number>();
  readonly diagnostics: Diagnostic[] = [];
  readonly symbols: VariableSymbol[] = [];
  readonly names = new Map<string, VariableSymbol>();
  readonly activeForVariables = new Set<number>();
  readonly constants = new Map<string, ConstantSymbol>();
  readonly declaredNames = new Set<string>();
  readonly expressions = new Map<AST.Expression, ExpressionInfo>();
  readonly references = new Map<AST.Identifier, ResolvedReference>();
  readonly functionArguments = new Map<AST.FunctionCall, readonly AST.Expression[]>();
  readonly arrayBounds = new Map<
    AST.FunctionCall,
    { array: AST.Expression; dimension: number; upper: boolean }
  >();
  readonly functions = new Map<AST.FunctionCall, StandardFunction>();
  readonly blockInOuts = new Map<
    AST.FunctionCall | AST.FunctionBlockCall,
    UserCallInfo["inOuts"]
  >();
  readonly userCalls = new Map<AST.FunctionCall | AST.FunctionBlockCall, UserCallInfo>();
  readonly blockInputTypes = new Map<AST.Identifier, DataType>();
  readonly blockCalls = new Map<AST.FunctionCall, number>();
  readonly failedBlockSelections = new Set<string>();
  readonly failedReferenceTypes = new Set<AST.Identifier>();
  readonly failedReferenceTargets = new Set<AST.TypeSyntax>();
  readonly unsupportedBlockArrays = new Set<AST.ArrayDeclaration>();

  constructor(
    inputs: CheckerInputs,
    readonly rules: RecursiveChecks,
  ) {
    this.ast = inputs.ast;
    this.pous = inputs.pous;
    this.functionIds = inputs.functionIds;
    this.blockIds = inputs.blockIds;
    this.types = inputs.types;
    this.interfaces = inputs.interfaces;
    this.globals = inputs.globals;
  }
}

/** A declaration's owner is an input to its checks, never a switched session field. */
export function declarationContext(
  ctx: CheckerContext,
  owner?: AST.Program,
  initializer = false,
): CheckerContext {
  return {
    ...ctx,
    declarationScope: { owner, ...(initializer ? { initializerOwner: owner } : {}) },
  };
}

export function report<C extends DiagnosticCode>(
  ctx: CheckerContext,
  code: C,
  args: DiagnosticArgs[C],
  span: SourceSpan,
): void {
  if (ctx.declarationScope?.owner && ctx.declarationScope.owner !== ctx.ast) {
    // The declaring type reports this error at its own source position.
    ctx.state.inheritedDeclarationError = true;
    return;
  }
  // Generic indexed arguments retain correlation at callers; TS cannot distribute C here.
  ctx.diagnostics.push({
    code,
    args,
    severity: "error",
    span,
    pou: ctx.ast.name.name,
  } as Diagnostic);
}
