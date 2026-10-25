import {
  readDirectValue,
  resolveType,
  type RetentiveRecord,
  writeDirectValue,
  directBits,
  type DirectAddress,
  type DataType,
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
  return Array<number>(64).fill(0);
}

/** Scan-stage extension point for host integrations. */
export interface ScanMemory {
  read(variable: number): ScalarValue;
  write(variable: number, value: ScalarValue): void;
}

type ScalarCell = (
  { kind: "scalar"; value: TypedValue } | { kind: "long"; dataType: LongType; value: bigint }
) & {
  descriptor: TypeDescriptor;
  location?: { bytes: number[]; address: DirectAddress; dataType: DataType };
};
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

  /** Share persistent receiver cells and append freshly initialized method locals. */
  methodFrame(definition: import("@benchtop-plc/core").UserMethodIR): MemoryFrame {
    return new MemoryFrame(
      [
        ...this.cells.slice(0, definition.memberCount),
        ...definition.variables.map((v) => initialCell(v, this.types)),
      ],
      this.types,
    );
  }

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
    if ((cell?.kind === "long" || cell?.kind === "scalar") && cell.location) {
      const { bytes, address, dataType } = cell.location;
      const value = readDirectValue(bytes, address, dataType);
      validateValue(dataType, value);
      return typed(dataType, value);
    }
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
    return cell?.kind === "long"
      ? cell.location
        ? BigInt(this.scalar(variable).value)
        : cell.value
      : this.scalar(variable).value;
  }

  write(variable: number, value: ScalarValue): void {
    const cell = this.cells[variable];
    if (cell?.kind === "long" || cell?.kind === "scalar") {
      value = truncateString(cell.descriptor, value, this.types);
      validateDeclaredValue(cell.descriptor, value, this.types);
    }
    if ((cell?.kind === "long" || cell?.kind === "scalar") && cell.location) {
      const { bytes, address, dataType } = cell.location;
      writeDirectValue(bytes, address, typed(dataType, value));
      return;
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
  private retainedType(type: TypeDescriptor): string {
    const resolved = resolveType(type, this.types);
    const base = scalarBase(type, this.types);
    return JSON.stringify({
      name: typeof type === "object" && type.kind === "named" ? type.name.toUpperCase() : undefined,
      type: isCharacterType(base) ? base : resolved,
    }).toUpperCase();
  }

  retentiveRecords(): RetentiveRecord[] {
    return this.ir.variables.flatMap((variable, id): RetentiveRecord[] => {
      if (
        !variable.retain ||
        variable.kind === "reference" ||
        (variable.kind === "scalar" && variable.address)
      )
        return [];
      if (variable.kind === "scalar")
        return [
          {
            kind: "leaf",
            path: variable.name,
            dataType: this.retainedType(variable.dataType),
            value: typed(scalarBase(variable.dataType, this.types), this.read(id)),
          },
        ];
      if (/^(TON|TOF|TP)(_|$)/.test(variable.fbType)) return [];
      const block = this.block(id);
      if (!block.retentiveState) return [];
      return [
        {
          kind: "block",
          path: variable.name,
          blockType: variable.fbType,
          inputs: block.inputs.map((v) => ({ ...v })),
          outputs: block.outputs.map((v) => ({ ...v })),
          state: { ...block.retentiveState() },
        },
      ];
    });
  }

  /** Restore matching records atomically per leaf/block; report missing and obsolete paths once. */
  restoreRetentive(records: readonly RetentiveRecord[]): string[] {
    const expected = this.retentiveRecords();
    const ids = new Map(this.ir.variables.map((variable, id) => [variable.name.toUpperCase(), id]));
    const remaining = new Map(expected.map((record) => [record.path.toUpperCase(), record]));
    const skipped = new Map<string, string>();
    const seen = new Set<string>();
    for (const record of records) {
      if (!record || typeof record.path !== "string") {
        skipped.set("?", "?");
        continue;
      }
      const key = record.path.toUpperCase();
      const target = remaining.get(key);
      if (!target || seen.has(key)) {
        skipped.set(key, record.path);
        continue;
      }
      seen.add(key);
      try {
        if (record.kind !== target.kind) throw new RangeError("Changed record kind");
        const id = ids.get(key)!;
        const variable = this.ir.variables[id]!;
        if (record.kind === "leaf" && target.kind === "leaf" && variable.kind === "scalar") {
          if (
            record.dataType !== target.dataType ||
            record.value.dataType !== target.value.dataType
          )
            throw new RangeError("Changed leaf type");
          const value = isCharacterType(record.value.dataType)
            ? truncateString(variable.dataType, record.value.value, this.types)
            : record.value.value;
          if (typeof value === "bigint") throw new RangeError("Non-JSON retained value");
          validateScalar(variable.dataType, value, this.types);
          this.write(id, value);
        } else if (
          record.kind === "block" &&
          target.kind === "block" &&
          variable.kind === "functionBlock"
        ) {
          if (record.blockType !== target.blockType) throw new RangeError("Changed block type");
          for (const port of ["inputs", "outputs"] as const) {
            if (record[port].length !== target[port].length) throw new RangeError("Changed ports");
            record[port].forEach((value, index) => {
              if (value.dataType !== target[port][index]!.dataType)
                throw new RangeError("Changed port type");
              validateValue(value.dataType, value.value);
            });
          }
          const block = this.block(id);
          if (!block.restoreRetentiveState) throw new RangeError("Block cannot restore");
          block.restoreRetentiveState(record.state);
          block.inputs.splice(0, block.inputs.length, ...record.inputs.map((v) => ({ ...v })));
          block.outputs.splice(0, block.outputs.length, ...record.outputs.map((v) => ({ ...v })));
        } else throw new RangeError("Changed storage kind");
        remaining.delete(key);
      } catch (error) {
        if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
        skipped.set(key, record.path);
      }
    }
    for (const [key, record] of remaining) skipped.set(key, record.path);
    return [...skipped.values()];
  }

  private readonly functionInitialCells: readonly ValueCell[][];
  private readonly instanceCells = new Map<number, UserBlockCell>();
  private readonly aggregateCells = new Map<string, AggregateCell & { path?: string }>();

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
    for (const block of ir.functionBlocks ?? []) {
      validateLiterals(block.body);
      for (const method of block.methods ?? []) {
        validateLiterals(method.body);
        method.variables.forEach((v) => initialCell(v, ir.types ?? []));
      }
    }
    this.functionInitialCells = functionInitialCells;
    ir.variables.forEach((variable, id) => {
      if (variable.kind !== "scalar" || !variable.address) return;
      const cell = this.cells[id]!;
      if (cell.kind !== "scalar" && cell.kind !== "long") throw new Error("Expected scalar view");
      cell.location = {
        bytes: this.areas[variable.address.area],
        address: variable.address,
        dataType: scalarBase(variable.dataType, this.types),
      };
      if (variable.address.area === "M" && variable.addressInitializer)
        this.write(id, variable.initialValue);
    });
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
  frame(storage: readonly InstanceStorage[]): MemoryFrame {
    return new MemoryFrame(this.storageCells(storage), this.types);
  }

  private storageCells(storage: readonly InstanceStorage[]): Cell[] {
    return storage.map((slot) => {
      if (slot.kind === "inOut") return { kind: "unbound" };
      if (slot.kind === "variable") return this.cells[slot.variable]!;
      if (slot.kind === "temporary") return initialCell(slot.variable, this.types);
      if (slot.kind === "array" || slot.kind === "structure") {
        const path = this.storagePath(slot)!;
        let cell = this.aggregateCells.get(path);
        if (!cell) {
          cell = { kind: "aggregate", descriptor: slot.dataType, elements: [], path };
          this.aggregateCells.set(path, cell);
          cell.elements.push(...this.storageCells(slot.elements));
        }
        return cell;
      }
      let cell = this.instanceCells.get(slot.instance);
      if (!cell) {
        const instance = this.ir.instances![slot.instance]!;
        const cells: Cell[] = [];
        const frame = new MemoryFrame(cells, this.types);
        cell = {
          kind: "userFunctionBlock",
          frame,
          block: instance.block,
          path: instance.path,
          resetTemporaries: () => frame.resetTemporaries(instance.storage),
        };
        // Externals may alias this instance again; publish its identity before following them.
        this.instanceCells.set(slot.instance, cell);
        cells.push(...this.storageCells(instance.storage));
      }
      return cell;
    });
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

  private readonly areas = { I: emptyImage(), Q: emptyImage(), M: Array<number>(1024).fill(0) };

  readAddress(address: DirectAddress, dataType: DataType): ScalarValue {
    const value = readDirectValue(this.areas[address.area], address, dataType);
    validateValue(dataType, value);
    return value;
  }

  writeAddress(address: DirectAddress, value: TypedValue): void {
    writeDirectValue(this.areas[address.area], address, value);
  }

  readInputs(image: IoImage): void {
    if (image.length !== 64 || image.some((v) => !Number.isInteger(v) || v < 0 || v > 255))
      throw new RangeError("Invalid input image");
    this.areas.I.splice(0, 64, ...image);
  }

  outputImage(): IoImage {
    return [...this.areas.Q];
  }

  clearOutputs(): void {
    this.areas.Q.fill(0);
  }

  snapshot(ids = this.cells.map((_, i) => i)): VariableSnapshot[] {
    return ids.map((id): VariableSnapshot => {
      const cell = this.cells[id]!;
      if (cell.kind === "reference") return this.referenceValue(cell.target);
      if ((cell.kind === "scalar" || cell.kind === "long") && cell.location) {
        const { bytes, address, dataType } = cell.location;
        const value = readDirectValue(bytes, address, dataType);
        if (typeof value === "number" && !Number.isFinite(value))
          return { kind: "invalidReal", bits: directBits(bytes, address) };
        return { kind: "scalar", ...typed(dataType, value) };
      }
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
