/** JSON data is deliberately independent of the future panel UI's widget catalog. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface FileHeader {
  companyName: string;
  productName: string;
  productVersion: string;
  creationDateTime: string;
  companyURL?: string;
  productRelease?: string;
  contentDescription?: string;
}

export interface ContentHeader {
  name: string;
  version?: string;
  modificationDateTime?: string;
  organization?: string;
  author?: string;
  language?: string;
}

/** Ordered POU texts and one configuration, resource and cyclic task. */
export interface Project {
  fileHeader: FileHeader;
  contentHeader: ContentHeader;
  pous: string[];
  configuration: string;
  resource: string;
  task: { name: string; interval: string; priority: number };
  instance?: { name: string; typeName: string };
  panel: JsonValue;
}

export interface VariableDeclaration {
  section: "localVars" | "inputVars" | "outputVars" | "tempVars" | "inOutVars";
  name: string;
  type: string;
  address?: string;
  initialValue?: string;
}

export interface SplitProgram {
  kind: "program" | "function" | "functionBlock";
  name: string;
  returnType?: string;
  variables: VariableDeclaration[];
  /** Exact text between the last END_VAR (or header) and the closing keyword. */
  body: string;
}

export type ProjectResult<T> =
  | { value: T; diagnostics: import("@benchtop-plc/core").Diagnostic[] }
  | { value: null; diagnostics: import("@benchtop-plc/core").Diagnostic[] };
