import {
  directBits,
  readDirectValue,
  formatValue,
  addressBinds,
  formatDirectAddress,
  parseDirectAddress,
  scalarBase,
  type DataType,
  type DirectAddress,
} from "@benchtop-plc/core";
import type { AppState } from "./store.js";
import type { ShellCatalog } from "./catalog.js";
type ImageState = Pick<
  AppState,
  "loadedIr" | "layout" | "snapshot" | "runtimeState" | "emergencyActive"
>;

/** HALT keeps the published image; a halt over STOP already has an empty image. */
export function outputsLive(state: Pick<AppState, "runtimeState" | "emergencyActive">): boolean {
  return !state.emergencyActive && (state.runtimeState === "RUN" || state.runtimeState === "HALT");
}

export interface ImageView {
  address: DirectAddress;
  text: string;
  dataType: DataType;
}
/** Collect used addresses; declarations and parameters determine each view's type. */
export function imageViews(state: ImageState): ImageView[] {
  const views = new Map<string, ImageView>();
  const add = (address: DirectAddress, type: unknown) => {
    if (address.area === "M" || !addressBinds(address, type)) return;
    const text = formatDirectAddress(address);
    views.set(`${text}:${type}`, { address, text, dataType: type });
  };
  const ir = state.loadedIr;
  for (const variable of ir?.variables ?? []) {
    if (variable.kind === "scalar" && variable.address)
      add(variable.address, scalarBase(variable.dataType, ir?.types));
  }
  for (const instance of ir?.resource.programs ?? []) {
    for (const connection of [...(instance.inputs ?? []), ...(instance.outputs ?? [])]) {
      if (connection.endpoint.kind !== "address" || connection.parameter.kind !== "variable")
        continue;
      const parameter = ir!.variables[connection.parameter.variable];
      if (parameter?.kind === "scalar")
        add(connection.endpoint.address, scalarBase(parameter.dataType, ir?.types));
    }
  }
  for (const task of ir?.resource.tasks ?? [])
    if ("single" in task && task.single.kind === "address") add(task.single.address, "BOOL");
  for (const part of state.layout) {
    const address = part.address && parseDirectAddress(part.address);
    if (address) add(address, part.dataType ?? "BOOL");
  }
  return [...views.values()];
}

/** Formatting and state masking stay shared between rendering and unit tests. */
export function imageReadings(state: ImageState, text: ShellCatalog) {
  const zero = Array<number>(64).fill(0);
  return imageViews(state).map(({ address, text: label, dataType }) => {
    const bytes = address.area === "I" ? state.snapshot?.inputs : state.snapshot?.outputs;
    const enabled = address.area === "I" || outputsLive(state);
    const image = bytes && enabled ? bytes : zero;
    const value = readDirectValue(image, address, dataType);
    const invalid = typeof value === "number" && !Number.isFinite(value);
    return {
      area: address.area,
      address: label,
      dataType,
      active: dataType === "BOOL" && value === true,
      value: invalid
        ? `${text.invalidReal} (${directBits(image, address)})`
        : dataType === "BOOL"
          ? value
            ? text.on
            : text.off
          : formatValue(dataType, value as string | number),
    };
  });
}
