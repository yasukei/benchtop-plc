import {
  coerceValue,
  standardFunctionBlocks,
  type FunctionBlockType,
  referenceType,
  type ReferenceVariable,
  type InlineValue,
  type ReferenceValue,
  arrayType,
  structureType,
  sameScalarType,
  type StructureVariable,
  type ArrayVariable,
  type InitialValue,
  truncateString,
  isCharacterType,
  validateValue,
  isLongType,
  isCalendarType,
  scalarBase,
  validateDeclaredValue,
  validateScalar,
  type TypeDescriptor,
  type TypeTable,
} from "@benchtop-plc/core";
import type {
  AssignmentTarget,
  CaseStatement,
  LiteralExpression,
  LongType,
  BitReference,
  FunctionBlockMemberReference,
  UserFunctionBlockMemberReference,
  InstanceStorage,
  IoImage,
  ProgramIR,
  ConfigurationIR,
  ScalarValue,
  ScalarVariable,
  TypedValue,
  VariableReference,
  VariableSnapshot,
} from "@benchtop-plc/core";
import type { FunctionBlockInstance, RuntimeLibrary } from "./library.js";

export function typed(dataType: TypedValue["dataType"], value: ScalarValue): TypedValue {
  // coerceValue preserves the discriminator/value relationship.
  return { dataType, value: coerceValue(dataType, value) } as TypedValue;
}

export function emptyImage(): IoImage {
  return [false, false, false, false, false, false, false, false];
}

/** Scan-stage extension point for host integrations. */
export interface ScanMemory {
  read(variable: number): ScalarValue;
  write(variable: number, value: ScalarValue): void;
}

type ScalarCell = (
  { kind: "scalar"; value: TypedValue } | { kind: "long"; dataType: LongType; value: bigint }
) & { descriptor: TypeDescriptor };
interface UserBlockCell {
  kind: "userFunctionBlock";
  frame: MemoryFrame;
  block: number;
  path: string;
  resetTemporaries(): void;
}
export interface ReferenceAddress {
  kind: "address";
  frame: MemoryFrame;
  variable: number;
}
export type StoredValue = ScalarValue | AggregateValue | ReferenceAddress | null;
export function isReferenceAddress(value: StoredValue): value is ReferenceAddress {
  return value !== null && typeof value === "object" && "kind" in value && value.kind === "address";
}
export interface AggregateValue {
  dataType: TypeDescriptor;
  elements: StoredValue[];
}
export function isAggregateValue(value: StoredValue): value is AggregateValue {
  return value !== null && typeof value === "object" && "elements" in value;
}
type AggregateCell = { kind: "aggregate"; descriptor: TypeDescriptor; elements: Cell[] };
type ReferenceCell = {
  kind: "reference";
  descriptor: TypeDescriptor;
  target: ReferenceAddress | null;
};
type PortCell = {
  kind: "port";
  descriptor: TypeDescriptor;
  instance: FunctionBlockInstance;
  port: "input" | "output";
  member: number;
};
type ValueCell = ScalarCell | ReferenceCell | AggregateCell;
type Cell = (
  | ReferenceCell
  | PortCell
  | AggregateCell
  | { kind: "unbound" }
  | ScalarCell
  | { kind: "functionBlock"; fbType: FunctionBlockType; instance: FunctionBlockInstance }
  | UserBlockCell
) & { path?: string };

function initialCell(
  variable: ScalarVariable | ReferenceVariable | ArrayVariable | StructureVariable,
  types: TypeTable,
): ValueCell {
  if (variable.kind === "array" || variable.kind === "structure") {
    const create = (type: TypeDescriptor, value: InitialValue): ValueCell => {
      const array = arrayType(type, types);
      const structure = structureType(type, types);
      if (array || structure)
        return {
          kind: "aggregate",
          descriptor: type,
          elements: (value as InitialValue[]).map((v, i) =>
            create(structure ? structure.members[i]!.dataType : array!.element, v),
          ),
        };
      return initialCell(
        { ...variable, kind: "scalar", dataType: type, initialValue: value } as ScalarVariable,
        types,
      );
    };
    return create(variable.dataType, variable.initialValue);
  }
  if (variable.kind === "reference" || referenceType(variable.dataType, types)) {
    if (variable.initialValue !== null) throw new RangeError("Reference initializer must be NULL");
    return { kind: "reference", descriptor: variable.dataType, target: null };
  }
  if (variable.initialValue === null) throw new RangeError("Unexpected NULL initializer");
  const dataType = scalarBase(variable.dataType, types);
  validateValue(dataType, variable.initialValue);
  validateDeclaredValue(variable.dataType, variable.initialValue, types);
  return isLongType(dataType)
    ? {
        kind: "long",
        dataType,
        value: BigInt(variable.initialValue),
        descriptor: variable.dataType,
      }
    : {
        kind: "scalar",
        value: typed(dataType, variable.initialValue),
        descriptor: variable.dataType,
      };
}

/** Mutable scalar/FB cells; function frames never perform load-time validation. */
export class MemoryFrame implements ScanMemory {
  constructor(
    protected readonly cells: Cell[],
    protected readonly types: TypeTable = [],
  ) {}

  asAggregateCell(descriptor: TypeDescriptor): AggregateCell & { path?: string } {
    return { kind: "aggregate", descriptor, elements: this.cells };
  }

  descriptor(variable: number): TypeDescriptor {
    const cell = this.cells[variable];
    if (!cell || !("descriptor" in cell)) throw new Error("Expected value storage");
    return cell.descriptor;
  }

  element(variable: number, offset: number): MemoryFrame {
    const cell = this.cells[variable];
    if (cell?.kind !== "aggregate" || !cell.elements[offset])
      throw new RangeError("Invalid aggregate storage");
    return new MemoryFrame([cell.elements[offset]!], this.types);
  }

  aggregateValue(variable: number): AggregateValue {
    const cell = this.cells[variable];
    if (cell?.kind !== "aggregate") throw new Error("Expected aggregate");
    return {
      dataType: cell.descriptor,
      elements: cell.elements.map((child, i) => {
        const frame = this.element(variable, i);
        return child.kind === "aggregate"
          ? frame.aggregateValue(0)
          : child.kind === "reference"
            ? frame.readReference(0)
            : frame.read(0);
      }),
    };
  }

  assignAggregate(variable: number, values: AggregateValue): void {
    // Open-array formals can bind different actual types. Check the concrete
    // descriptors before changing any destination leaf.
    if (!sameScalarType(this.descriptor(variable), values.dataType, this.types))
      throw new RangeError("Incompatible aggregate copy");
    values.elements.forEach((value, i) => {
      const frame = this.element(variable, i);
      if (isAggregateValue(value)) frame.assignAggregate(0, value);
      else if (value === null || isReferenceAddress(value)) frame.writeReference(0, value);
      else frame.write(0, value);
    });
  }

  /** Share the actual cell, including when it is already an in-out alias. */
  bind(variable: number, caller: MemoryFrame, actual: number): void {
    const cell = caller.cells[actual];
    if (
      !cell ||
      (cell.kind !== "scalar" &&
        cell.kind !== "long" &&
        cell.kind !== "aggregate" &&
        cell.kind !== "reference" &&
        cell.kind !== "port")
    )
      throw new Error("Expected value in-out actual");
    this.cells[variable] = cell;
  }

  unbind(variables: readonly number[]): void {
    for (const variable of variables) this.cells[variable] = { kind: "unbound" };
  }

  address(variable: number): ReferenceAddress {
    return { kind: "address", frame: this, variable };
  }
  sameLocation(variable: number, other: ReferenceAddress): boolean {
    return this.cells[variable] === other.frame.cells[other.variable];
  }
  referenceValue(address: ReferenceAddress | null): ReferenceValue {
    return {
      kind: "reference",
      target: address ? address.frame.cells[address.variable]!.path! : null,
    };
  }
  readReference(variable: number): ReferenceAddress | null {
    const cell = this.cells[variable];
    if (cell?.kind !== "reference") throw new Error("Expected reference cell");
    return cell.target;
  }
  writeReference(variable: number, target: ReferenceAddress | null): ReferenceValue {
    const cell = this.cells[variable];
    if (cell?.kind !== "reference") throw new Error("Expected reference cell");
    cell.target = target;
    return this.referenceValue(target);
  }
  inlineValue(variable: number): InlineValue {
    const cell = this.cells[variable];
    return cell?.kind === "reference"
      ? this.referenceValue(cell.target)
      : { ...this.scalar(variable) };
  }
  private static readonly ports = new WeakMap<Cell, Map<string, MemoryFrame>>();
  portFrame(variable: number, port: "input" | "output", member: number): MemoryFrame {
    const cell = this.cells[variable]!;
    if (cell.kind !== "functionBlock") throw new Error("Expected function block");
    let ports = MemoryFrame.ports.get(cell);
    if (!ports) {
      ports = new Map();
      MemoryFrame.ports.set(cell, ports);
    }
    const name =
      standardFunctionBlocks[cell.fbType][port === "input" ? "inputs" : "outputs"][member]![0];
    const key = `${port}:${member}`;
    let frame = ports.get(key);
    if (!frame) {
      const value = (port === "input" ? cell.instance.inputs : cell.instance.outputs)[member]!;
      frame = new MemoryFrame(
        [
          {
            kind: "port",
            descriptor: value.dataType,
            instance: cell.instance,
            port,
            member,
            path: `${cell.path}.${name}`,
          },
        ],
        this.types,
      );
      ports.set(key, frame);
    }
    return frame;
  }
  private scalar(variable: number): TypedValue {
    const cell = this.cells[variable];
    if (cell?.kind === "port")
      return (cell.port === "input" ? cell.instance.inputs : cell.instance.outputs)[cell.member]!;
    if (cell?.kind === "long") return typed(cell.dataType, cell.value);
    if (!cell || cell.kind !== "scalar") throw new Error("Expected scalar variable");
    return cell.value;
  }

  block(variable: number): FunctionBlockInstance {
    const cell = this.cells[variable];
    if (!cell || cell.kind !== "functionBlock") throw new Error("Expected function block");
    return cell.instance;
  }

  userBlock(variable: number): UserBlockCell {
    const cell = this.cells[variable];
    if (!cell || cell.kind !== "userFunctionBlock") throw new Error("Expected user function block");
    return cell;
  }

  resetTemporaries(storage: readonly InstanceStorage[]): void {
    storage.forEach((slot, index) => {
      if (slot.kind === "temporary") this.cells[index] = initialCell(slot.variable, this.types);
    });
  }

  read(variable: number): ScalarValue {
    const cell = this.cells[variable];
    return cell?.kind === "long" ? cell.value : this.scalar(variable).value;
  }

  write(variable: number, value: ScalarValue): void {
    const cell = this.cells[variable];
    if (cell?.kind === "long" || cell?.kind === "scalar") {
      value = truncateString(cell.descriptor, value, this.types);
      validateDeclaredValue(cell.descriptor, value, this.types);
    }
    if (cell?.kind === "long") {
      cell.value = BigInt(coerceValue(cell.dataType, value));
      return;
    }
    const scalar = this.scalar(variable);
    scalar.value = coerceValue(scalar.dataType, value);
  }

  value(
    ref:
      | VariableReference
      | BitReference
      | FunctionBlockMemberReference
      | UserFunctionBlockMemberReference,
  ): TypedValue {
    if (ref.kind === "bit")
      return {
        dataType: "BOOL",
        value: (BigInt(this.read(ref.variable)) & (1n << BigInt(ref.bit))) !== 0n,
      };
    if (ref.kind === "variable") return { ...this.scalar(ref.variable) };
    if (ref.kind === "userFbMember")
      return typed(
        scalarBase(ref.dataType, this.types),
        this.userBlock(ref.variable).frame.read(ref.member),
      );
    const instance = this.block(ref.variable);
    const value = (ref.port === "input" ? instance.inputs : instance.outputs)[ref.member];
    if (!value) throw new Error("Expected function block port");
    return { ...value };
  }

  assign(
    target: Exclude<
      AssignmentTarget,
      { kind: "index" | "elementBit" | "structureMember" | "dereference" }
    >,
    value: ScalarValue,
  ): TypedValue {
    if (target.kind === "bit") {
      const pattern = BigInt(this.read(target.variable)),
        mask = 1n << BigInt(target.bit);
      this.write(target.variable, value ? pattern | mask : pattern & ~mask);
    } else if (target.kind === "variable") this.write(target.variable, value);
    else if (target.kind === "userFbMember")
      this.userBlock(target.variable).frame.write(target.member, value);
    else this.input(target.variable, target.member, value);
    return this.value(target);
  }

  input(variable: number, index: number, value: ScalarValue): void {
    const inputs = this.block(variable).inputs;
    const input = inputs[index];
    if (!input) throw new Error("Expected function block input");
    inputs[index] = typed(input.dataType, value);
  }
}

export class Memory extends MemoryFrame {
  private readonly functionInitialCells: readonly ValueCell[][];
  private readonly instanceCells = new Map<number, UserBlockCell>();

  constructor(
    readonly ir: ProgramIR | ConfigurationIR,
    library?: RuntimeLibrary,
  ) {
    // Check literals even in branches that are not executed. No untrusted long value
    // may be normalized merely because BigInt accepts its syntax.
    const validateLiterals = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (
        "kind" in node &&
        node.kind === "literal" &&
        "dataType" in node &&
        "value" in node &&
        typeof node.dataType === "string" &&
        (isLongType(node.dataType) ||
          isCalendarType(node.dataType) ||
          isCharacterType(node.dataType))
      )
        validateValue(node.dataType, node.value);
      if (
        "kind" in node &&
        node.kind === "literal" &&
        "dataType" in node &&
        typeof node.dataType === "object"
      ) {
        const literal = node as LiteralExpression;
        validateScalar(literal.dataType, literal.value, ir.types);
      }
      if ("kind" in node && node.kind === "case") {
        // The IR shape is compiler-checked; value validation also covers label payloads.
        const statement = node as CaseStatement;
        const type = scalarBase(statement.selector.dataType, ir.types);
        if (isLongType(type)) {
          for (const branch of statement.branches) {
            for (const label of branch.labels) {
              if (label.kind === "value") validateValue(type, label.value);
              else {
                validateValue(type, label.lower);
                validateValue(type, label.upper);
              }
            }
          }
        }
      }
      for (const child of Object.values(node)) validateLiterals(child);
    };
    if (ir.kind === "configuration")
      ir.programs.forEach((program) => validateLiterals(program.body));
    else validateLiterals(ir.body);
    const functionInitialCells = (ir.functions ?? []).map((fn) => {
      validateLiterals(fn.body);
      return fn.variables.map((variable) => initialCell(variable, ir.types ?? []));
    });
    super(
      ir.variables.map((variable): Cell => {
        if (variable.kind === "scalar" || variable.kind === "reference")
          return { ...initialCell(variable, ir.types ?? []), path: variable.name };
        if (!library) throw new Error("A runtime library is required for function blocks");
        return {
          kind: "functionBlock",
          fbType: variable.fbType,
          instance: library.createFunctionBlock(variable.fbType),
          path: variable.name,
        };
      }),
      ir.types ?? [],
    );
    for (const block of ir.functionBlocks ?? []) validateLiterals(block.body);
    this.functionInitialCells = functionInitialCells;
  }

  private storagePath(slot: InstanceStorage): string | undefined {
    if (slot.kind === "variable") return this.ir.variables[slot.variable]!.name;
    if (slot.kind === "instance") return this.ir.instances![slot.instance]!.path;
    if (slot.kind === "array" || slot.kind === "structure") {
      const child = slot.elements[0] && this.storagePath(slot.elements[0]);
      return child?.replace(/(\[[^\]]*\]|\.[^.[]+)$/, "");
    }
    return undefined;
  }
  private frame(storage: readonly InstanceStorage[]): MemoryFrame {
    return new MemoryFrame(
      storage.map((slot) => {
        if (slot.kind === "inOut") return { kind: "unbound" };
        if (slot.kind === "variable") return this.cells[slot.variable]!;
        if (slot.kind === "temporary") return initialCell(slot.variable, this.types);
        if (slot.kind === "array" || slot.kind === "structure")
          return {
            ...this.frame(slot.elements).asAggregateCell(slot.dataType),
            path: this.storagePath(slot),
          };
        let cell = this.instanceCells.get(slot.instance);
        if (!cell) {
          const instance = this.ir.instances![slot.instance]!;
          const frame = this.frame(instance.storage);
          cell = {
            kind: "userFunctionBlock",
            frame,
            block: instance.block,
            path: instance.path,
            resetTemporaries: () => frame.resetTemporaries(instance.storage),
          };
          this.instanceCells.set(slot.instance, cell);
        }
        return cell;
      }),
      this.types,
    );
  }

  private readonly programFrames = new Map<number, MemoryFrame>();

  /** Each instance keeps aggregate identity while refreshing its own temporaries. */
  programFrame(index = 0): MemoryFrame {
    const storage =
      this.ir.kind === "configuration"
        ? this.ir.resource.programs[index]!.storage
        : this.ir.storage;
    if (!storage) return this;
    let frame = this.programFrames.get(index);
    if (!frame) {
      frame = this.frame(storage);
      this.programFrames.set(index, frame);
    } else frame.resetTemporaries(storage);
    return frame;
  }

  /** Clone validated initial cells, keeping each invocation independent. */
  functionFrame(index: number): MemoryFrame {
    const initial = this.functionInitialCells[index];
    if (!initial) throw new Error("Missing function locals");
    return new MemoryFrame(
      initial.map(function clone(cell: Cell): ValueCell {
        if (cell.kind === "aggregate")
          return {
            kind: "aggregate",
            descriptor: cell.descriptor,
            elements: cell.elements.map(clone),
          };
        if (cell.kind === "long" || cell.kind === "reference") return { ...cell };
        if (cell.kind === "scalar") return { ...cell, value: { ...cell.value } };
        throw new Error("Instance in function initial storage");
      }),
      this.types,
    );
  }

  readInputs(image: IoImage): void {
    this.ir.variables.forEach((variable, index) => {
      if (variable.kind === "scalar" && variable.address?.area === "I") {
        this.write(index, image[variable.address.bit]);
      }
    });
  }

  outputImage(): IoImage {
    const image = emptyImage();
    this.ir.variables.forEach((variable, index) => {
      if (variable.kind === "scalar" && variable.address?.area === "Q") {
        image[variable.address.bit] = Boolean(this.read(index));
      }
    });
    return image;
  }

  clearOutputs(): void {
    this.ir.variables.forEach((variable, index) => {
      if (variable.kind === "scalar" && variable.address?.area === "Q") this.write(index, false);
    });
  }

  snapshot(ids = this.cells.map((_, i) => i)): VariableSnapshot[] {
    return ids.map((id): VariableSnapshot => {
      const cell = this.cells[id]!;
      if (cell.kind === "reference") return this.referenceValue(cell.target);
      if (cell.kind === "long") return { kind: "scalar", ...typed(cell.dataType, cell.value) };
      if (cell.kind === "scalar") return { kind: "scalar", ...cell.value };
      if (cell.kind !== "functionBlock") throw new Error("User instance in monitored storage");
      return {
        kind: "functionBlock",
        inputs: cell.instance.inputs.map((value) => ({ ...value })),
        outputs: cell.instance.outputs.map((value) => ({ ...value })),
      };
    });
  }
}
