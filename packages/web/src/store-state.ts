import type {
  ConfigurationIR,
  Diagnostic,
  HaltedMessage,
  RuntimeSnapshot,
  RuntimeState,
  CommandRejectionMessage,
} from "@benchtop-plc/core";
import type { EditableWork } from "./editable-work.js";
import type { SavedSelection } from "./selection.js";

export interface StoreState extends EditableWork {
  storageWarning: boolean;
  retentiveSkipped: string[];
  openDiagnostics: Diagnostic[];
  openProjectError: "unsupported-cycle" | "example-load" | null;
  emergencyActive: boolean;
  emergencyReleased: boolean;
  loadedSources: string[] | null;
  loadedDataTypes: string[] | null;
  loadedConfigurationSource: string | null;
  loadedIr?: ConfigurationIR;
  runtimeState: RuntimeState;
  halted: HaltedMessage | null;
  selectedFrame: number;
  snapshot: RuntimeSnapshot | null;
  diagnostic: Diagnostic | null;
  rejection: CommandRejectionMessage | null;
  connection: "connected" | "failed" | "closed";
}

export type AppState = Omit<StoreState, "selection"> & SavedSelection;
