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

/** Exactly one program, configuration, resource, cyclic task and bound instance. */
export interface Project {
  fileHeader: FileHeader;
  contentHeader: ContentHeader;
  program: string;
  configuration: string;
  resource: string;
  task: { name: string; interval: string; priority: number };
  instance: { name: string; typeName: string };
  panel: JsonValue;
}

export interface VariableDeclaration {
  name: string;
  type: string;
  address?: string;
  initialValue?: string;
}

export interface SplitProgram {
  name: string;
  variables: VariableDeclaration[];
  /** Exact text between the last END_VAR (or program name) and END_PROGRAM. */
  body: string;
}

export type ProjectResult<T> =
  | { value: T; diagnostics: import("@benchtop-plc/core").Diagnostic[] }
  | { value: null; diagnostics: import("@benchtop-plc/core").Diagnostic[] };
