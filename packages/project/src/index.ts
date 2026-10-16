export const packageName = "@benchtop-plc/project";
export type {
  ContentHeader,
  FileHeader,
  JsonValue,
  Project,
  ProjectResult,
  SplitProgram,
  VariableDeclaration,
} from "./model.js";
export { splitProgram, joinProgram } from "./text.js";
export { readProject, writeProject } from "./codec.js";
export { TC6_NAMESPACE, XHTML_NAMESPACE, PANEL_NAMESPACE, SOURCE_NAMESPACE } from "./xml.js";
