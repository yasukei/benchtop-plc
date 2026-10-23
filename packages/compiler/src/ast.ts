import type { BinaryOperator, DataType, SourceNode, UnaryOperator } from "@benchtop-plc/core";

/** Names remain unresolved; spelling is retained and key is the case-insensitive identity. */
export interface Identifier extends SourceNode {
  name: string;
  key: string;
}

/** Syntactically valid addresses may exceed the runtime's supported I/O range. */
export interface Address extends SourceNode {
  text: string;
  area: "I" | "Q";
  byte: number;
  bit: number;
}

export interface Program extends SourceNode {
  kind: "program" | "function" | "functionBlock";
  name: Identifier;
  resultType?: Identifier;
  resultSubrange?: Subrange;
  resultStringLength?: number;
  sections?: { name: string; constant?: boolean; span: import("@benchtop-plc/core").SourceSpan }[];
  declarations: Declaration[];
  body: Statement[];
}

export interface Declaration extends SourceNode {
  kind: "declaration";
  names: [Identifier, ...Identifier[]];
  address?: Address;
  typeName: Identifier;
  subrange?: Subrange;
  stringLength?: number;
  array?: ArrayDeclaration;
  initializer?: Expression;
  constant?: boolean;
  /** Absent means VAR, preserving the original single-program AST. */
  section?: "VAR_INPUT" | "VAR_OUTPUT" | "VAR_IN_OUT" | "VAR_TEMP";
}

export type Literal = SourceNode & { kind: "literal"; text: string; dataType?: DataType } & (
    | { literalKind: "integer" | "real" | "time" | "calendar"; value: number }
    | { literalKind: "boolean"; value: boolean }
    | { literalKind: "string"; value: string }
  );

export interface NameReference extends SourceNode {
  kind: "name";
  name: Identifier;
}

export interface MemberReference extends SourceNode {
  kind: "member";
  instance: Identifier;
  member: Identifier;
}

export interface ArrayAccess extends SourceNode {
  kind: "index";
  array: NameReference | ArrayAccess;
  indices: Expression[];
}
export interface ElementBit extends SourceNode {
  kind: "elementBit";
  element: ArrayAccess;
  member: Identifier;
}
export interface ArrayInitializer extends SourceNode {
  kind: "arrayInitializer";
  items: { count?: Expression; values: Expression[] }[];
}
export interface ArrayDeclaration extends SourceNode {
  dimensions: Subrange[];
  typeName: Identifier;
  subrange?: Subrange;
  stringLength?: number;
  array?: ArrayDeclaration;
}
export type AssignmentTarget = NameReference | MemberReference | ArrayAccess | ElementBit;

export interface UnaryExpression extends SourceNode {
  kind: "unary";
  operator: UnaryOperator;
  operand: Expression;
}

export interface BinaryExpression extends SourceNode {
  kind: "binary";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

/** Parentheses have their own span, leaving the enclosed node's span exact. */
export interface GroupExpression extends SourceNode {
  kind: "group";
  expression: Expression;
}

export interface FunctionCall extends SourceNode {
  kind: "functionCall";
  name: Identifier;
  args: Expression[];
  /** Present for formal calls; positional and formal inputs cannot be mixed. */
  inputNames?: Identifier[];
  outputs?: NamedOutput[];
}

export interface EnumerationLiteral extends SourceNode {
  kind: "enumeration";
  typeName: Identifier;
  member: Identifier;
}
export interface Subrange extends SourceNode {
  lower: Expression;
  upper: Expression;
}
export interface DataTypeDeclaration extends SourceNode {
  array?: ArrayDeclaration;
  name: Identifier;
  typeName?: Identifier;
  subrange?: Subrange;
  stringLength?: number;
  values?: { name: Identifier; value?: Expression }[];
  initializer?: Expression;
}

export type Expression =
  | ArrayInitializer
  | EnumerationLiteral
  | Literal
  | AssignmentTarget
  | UnaryExpression
  | BinaryExpression
  | GroupExpression
  | FunctionCall;

export interface Assignment extends SourceNode {
  kind: "assignment";
  target: AssignmentTarget;
  value: Expression;
}

export interface NamedInput extends SourceNode {
  name: Identifier;
  value: Expression;
}

export interface NamedOutput extends SourceNode {
  name: Identifier;
  target: AssignmentTarget;
}

export interface FunctionCallStatement extends SourceNode {
  kind: "call";
  call: FunctionCall;
}

export interface FunctionBlockCall extends SourceNode {
  kind: "fbCall";
  instance: Identifier;
  inputs: NamedInput[];
}

export interface ConditionalBranch extends SourceNode {
  condition: Expression;
  body: Statement[];
}

export interface IfStatement extends SourceNode {
  kind: "if";
  branches: [ConditionalBranch, ...ConditionalBranch[]];
  elseBody: Statement[];
}

/** Labels are expressions until the semantic pass checks integer constants. */
export type CaseLabel = SourceNode &
  ({ kind: "value"; value: Expression } | { kind: "range"; lower: Expression; upper: Expression });

export interface CaseBranch extends SourceNode {
  labels: [CaseLabel, ...CaseLabel[]];
  body: Statement[];
}

export interface CaseStatement extends SourceNode {
  kind: "case";
  selector: Expression;
  branches: CaseBranch[];
  elseBody: Statement[];
}

export interface ForStatement extends SourceNode {
  kind: "for";
  variable: Identifier;
  from: Expression;
  to: Expression;
  /** Omitted BY stays absent; the semantic pass supplies the default. */
  step?: Expression;
  body: Statement[];
}

export interface WhileStatement extends SourceNode {
  kind: "while";
  condition: Expression;
  body: Statement[];
}

export interface RepeatStatement extends SourceNode {
  kind: "repeat";
  body: Statement[];
  until: Expression;
}

export type Statement =
  | Assignment
  | FunctionBlockCall
  | FunctionCallStatement
  | IfStatement
  | CaseStatement
  | ForStatement
  | WhileStatement
  | RepeatStatement
  | (SourceNode & { kind: "exit" | "return" });
