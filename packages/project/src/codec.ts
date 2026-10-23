import {
  check,
  parsePou,
  parseDataType,
  resolveDataTypes,
  type DataTypeDeclaration,
} from "@benchtop-plc/compiler";
import {
  MAX_STRING_LENGTH,
  formatType,
  isIntegerType,
  type TypeTable,
  type Diagnostic,
} from "@benchtop-plc/core";
import type {
  ContentHeader,
  FileHeader,
  JsonValue,
  Project,
  ProjectResult,
  SplitProgram,
  VariableDeclaration,
} from "./model.js";
import {
  canonicalBody,
  canonicalInitializer,
  joinProgram,
  splitProgram,
  expressionText,
  containsSpan,
  normalizeType,
} from "./text.js";
import {
  element,
  escapeXml,
  PANEL_NAMESPACE,
  parseXml,
  SOURCE_NAMESPACE,
  TC6_NAMESPACE,
  XHTML_NAMESPACE,
} from "./xml.js";
import type { XmlNode } from "./xml.js";

const elementaryTypes = new Set(
  "BOOL SINT INT DINT LINT USINT UINT UDINT ULINT REAL LREAL TIME LTIME DATE DT TOD LDATE LTOD LDT BYTE WORD DWORD LWORD".split(
    " ",
  ),
);
const xmlTypes: Record<string, string> = {
  STRING: "string",
  WSTRING: "wstring",
  TIME_OF_DAY: "TOD",
  DATE_AND_TIME: "DT",
  LTIME_OF_DAY: "LTOD",
  LDATE_AND_TIME: "LDT",
};
const fileRequired = ["companyName", "productName", "productVersion", "creationDateTime"];
const fileOptional = ["companyURL", "productRelease", "contentDescription"];
const contentOptional = ["version", "modificationDateTime", "organization", "author", "language"];

class ProjectError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.code);
  }
}
function fail(
  code: "project.missing" | "project.unsupported" | "project.invalid",
  path: string,
): never {
  throw new ProjectError({ code, severity: "error", args: { path } });
}

function shape(node: XmlNode, attributes: string[], children: string[], text = false): void {
  if (node.uri !== TC6_NAMESPACE) fail("project.unsupported", `{${node.uri}}${node.name}`);
  for (const key of Object.keys(node.attributes)) {
    if (!attributes.includes(key)) fail("project.unsupported", `${node.name}/@${key}`);
  }
  for (const child of node.children) {
    if (child.uri !== TC6_NAMESPACE || ![...children, "addData"].includes(child.name)) {
      fail("project.unsupported", `${node.name}/{${child.uri}}${child.name}`);
    }
  }
  if (!text && node.text.trim()) fail("project.invalid", `${node.name}/text()`);
  one(node, "addData", false);
}
function one(node: XmlNode, name: string, required = true): XmlNode | undefined {
  const found = node.children.filter((child) => child.uri === TC6_NAMESPACE && child.name === name);
  if (found.length > 1) fail("project.unsupported", `${node.name}/${name}[2]`);
  if (!found.length && required) fail("project.missing", `${node.name}/${name}`);
  return found[0];
}
function required(node: XmlNode, name: string): XmlNode {
  return one(node, name)!;
}
function attribute(node: XmlNode, name: string): string {
  const value = node.attributes[name];
  if (value === undefined) fail("project.missing", `${node.name}/@${name}`);
  return value;
}
function leaf(node: XmlNode, attributes: string[]): void {
  shape(node, attributes, []);
}
function dateTime(value: string, path: string): void {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))?$/.exec(
      value,
    );
  if (!match) fail("project.invalid", path);
  const [, year, month, day, hour, minute, second, zoneHour, zoneMinute] = match.map(Number);
  const days = [
    31,
    year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year! < 1 ||
    month! < 1 ||
    month! > 12 ||
    day! < 1 ||
    day! > days[month! - 1]! ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59 ||
    zoneHour! > 14 ||
    zoneMinute! > 59 ||
    (zoneHour === 14 && zoneMinute !== 0)
  )
    fail("project.invalid", path);
}

function validJson(value: unknown, seen = new Set<object>(), depth = 0): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 128 || seen.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  seen.add(value);
  const entries: unknown[] = Array.isArray(value) ? Array.from(value) : Object.values(value);
  const valid = entries.every((entry) => validJson(entry, seen, depth + 1));
  seen.delete(value);
  return valid;
}
function interval(value: string): boolean {
  // Fixed, positive ISO 8601 durations only; months/years and variable-triggered tasks are unsupported.
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  return (
    !!match &&
    !value.endsWith("T") &&
    match.slice(1).some((part) => Number(part) > 0) &&
    match.slice(1).every((part) => part === undefined || Number.isFinite(Number(part)))
  );
}
function validateIdentifier(name: string, path: string): void {
  const result = splitProgram(`PROGRAM ${name}\nEND_PROGRAM`);
  if (!result.value || result.value.name !== name) fail("project.invalid", path);
}

function validateInitializers(program: SplitProgram, types: TypeTable): void {
  const ast = parsePou(joinProgram(program)).ast;
  if (!ast) fail("project.invalid", "pou/interface");
  // Check declarations together in their POU context; body/name/section errors do not block exchange.
  const result = check({ ...ast, body: [] }, new Map(), new Map(), new Map(), types);
  for (const declaration of ast.declarations) {
    const span = declaration.initializer?.span;
    if (!span) continue;
    // As before, an unresolved declaration type cannot be range-checked yet.
    if (
      result.diagnostics.some(
        (item) =>
          item.code === "decl.unknown-type" &&
          item.span?.line === declaration.typeName.span.line &&
          item.span.column === declaration.typeName.span.column,
      )
    )
      continue;
    if (
      result.diagnostics.some(
        (item) =>
          item.severity === "error" &&
          item.code !== "name.undeclared" &&
          item.code !== "decl.unknown-type" &&
          item.code !== "decl.in-out-initializer" &&
          item.span &&
          containsSpan(span, item.span),
      )
    )
      fail("project.invalid", `variable/${declaration.names[0].name}/initialValue`);
  }
}

interface SplitDataType {
  name: string;
  type: string;
  initialValue?: string;
}
function parseType(source: string): DataTypeDeclaration {
  const parsed = parseDataType(source);
  if (!parsed.ast) throw new ProjectError(parsed.diagnostics[0]!);
  return parsed.ast;
}
function joinDataType(type: SplitDataType): string {
  return `TYPE ${type.name} : ${type.type}${type.initialValue === undefined ? "" : ` := ${type.initialValue}`}; END_TYPE\n`;
}
function splitDataType(source: string, declarations: DataTypeDeclaration[]): SplitDataType {
  const ast = parseType(source);
  // Initializers do not change the TC6 base type. Resolve definitions separately
  // so an unresolved initializer can still be exchanged (ADR 0014/0015).
  const context = declarations.filter((item) => item.name.key !== ast.name.key);
  context.push(ast);
  const resolved = resolveDataTypes(context.map((item) => ({ ...item, initializer: undefined })));
  const definition = resolved.types.find(
    (item) => item.name.toUpperCase() === ast.name.key,
  )?.definition;
  if (
    ast.stringLength !== undefined &&
    resolved.diagnostics.some(
      (item) => item.pou === ast.name.name && item.code === "type.invalid-constant",
    )
  )
    fail("project.invalid", `dataType/${ast.name.name}/baseType`);
  let type =
    normalizeType(ast.typeName?.key ?? "INT") +
    (ast.stringLength === undefined ? "" : `[${ast.stringLength}]`);
  if (ast.array) {
    if (definition?.kind === "alias") type = formatType(definition.type);
    else {
      const split = splitProgram(
        `PROGRAM __TYPE_SOURCE VAR __VALUE : ${expressionText(source, ast.array.span)}; END_VAR END_PROGRAM`,
        resolved.types,
      );
      if (!split.value) fail("project.invalid", `dataType/${ast.name.name}/baseType`);
      type = split.value.variables[0]!.type;
    }
  }
  if (ast.values || ast.subrange) {
    if (resolved.diagnostics.some((item) => item.pou === ast.name.name))
      fail("project.invalid", `dataType/${ast.name.name}/baseType`);
    if (definition?.kind === "enumeration")
      type = `${definition.base} (${definition.values.map((item) => `${item.name} := ${item.value}`).join(", ")})`;
    else if (definition?.kind === "subrange")
      type = `${definition.base} (${definition.lower}..${definition.upper})`;
    else fail("project.invalid", `dataType/${ast.name.name}/baseType`);
  }
  // Slice initializer text by lexer spans, including CRLF sources.
  const initialValue = ast.initializer ? canonicalInitializer(source, ast.initializer) : undefined;
  return { name: ast.name.name, type, ...(initialValue === undefined ? {} : { initialValue }) };
}
function validateTypeInitializers(asts: DataTypeDeclaration[]): void {
  for (const ast of asts) {
    const span = ast.initializer?.span;
    if (!span) continue;
    // Check each declaration even when duplicate names are preserved as semantic errors.
    const context = asts.filter((other) => other.name.key !== ast.name.key);
    const { diagnostics } = resolveDataTypes([...context, ast]);
    if (
      diagnostics.some(
        (item) =>
          item.pou === ast.name.name &&
          item.code !== "name.undeclared" &&
          item.code !== "decl.unknown-type" &&
          item.span &&
          containsSpan(span, item.span),
      )
    )
      fail("project.invalid", `dataType/${ast.name.name}/initialValue`);
  }
}
function readInitialValue(node: XmlNode): string | undefined {
  const initial = one(node, "initialValue", false);
  if (!initial) return undefined;
  const read = (value: XmlNode): string => {
    shape(value, value.name === "value" ? ["repetitionValue"] : [], ["simpleValue", "arrayValue"]);
    const children = value.children.filter((child) => child.name !== "addData");
    if (children.length !== 1) fail("project.invalid", `${value.name}/value`);
    const child = children[0]!;
    if (child.name === "simpleValue") {
      leaf(child, ["value"]);
      return attribute(child, "value");
    }
    shape(child, [], ["value"]);
    return `[${child.children
      .filter((item) => item.name === "value")
      .map((item) => {
        const text = read(item),
          repetition = item.attributes.repetitionValue;
        if (
          repetition !== undefined &&
          (!/^[0-9]+$/.test(repetition) || Number(repetition) > 10000)
        )
          fail("project.invalid", "arrayValue/repetitionValue");
        return repetition === undefined ? text : `${repetition}(${text})`;
      })
      .join(", ")}]`;
  };
  return read(initial);
}
function initialXml(value: string | undefined): string {
  if (value === undefined) return "";
  if (!value.trimStart().startsWith("["))
    return element("initialValue", {}, element("simpleValue", { value }));
  const source = `PROGRAM Initial VAR a : INT := ${value}; END_VAR END_PROGRAM`;
  const initializer = parsePou(source).ast?.declarations[0]?.initializer;
  if (!initializer) fail("project.invalid", "arrayValue");
  const encode = (node: import("@benchtop-plc/compiler").Expression): string => {
    if (node.kind !== "arrayInitializer")
      return element("simpleValue", { value: expressionText(source, node.span) });
    return element(
      "arrayValue",
      {},
      node.items
        .map((item) => {
          if (!item.count) return item.values.map((v) => element("value", {}, encode(v))).join("");
          const countText = expressionText(source, item.count.span);
          const ast = parsePou(
            `PROGRAM Count VAR n : DINT := ${countText}; END_VAR END_PROGRAM`,
          ).ast;
          const count = ast && check(ast).checked?.symbols[0]?.initialValue;
          if (typeof count !== "number" || count < 0 || count > 10000)
            fail("project.invalid", "arrayValue/repetitionValue");
          if (item.values.length === 1)
            return element("value", { repetitionValue: String(count) }, encode(item.values[0]!));
          return Array.from({ length: count }, () =>
            item.values.map((v) => element("value", {}, encode(v))).join(""),
          ).join("");
        })
        .join(""),
    );
  };
  return element("initialValue", {}, encode(initializer));
}

function readType(type: XmlNode, enumeration = false): string {
  shape(
    type,
    [],
    [
      ...elementaryTypes,
      "string",
      "wstring",
      "derived",
      "array",
      "subrangeSigned",
      "subrangeUnsigned",
      ...(enumeration ? ["enum"] : []),
    ],
  );
  const choices = type.children.filter((child) => child.name !== "addData");
  if (choices.length !== 1) fail("project.invalid", `${type.name}/type`);
  const choice = choices[0]!;
  if (choice.name === "array") {
    shape(choice, [], ["dimension", "baseType"]);
    const dimensions = choice.children
      .filter((child) => child.name === "dimension")
      .map((d) => {
        leaf(d, ["lower", "upper"]);
        const lower = attribute(d, "lower"),
          upper = attribute(d, "upper");
        if (
          !/^[+-]?\d+$/.test(lower) ||
          !/^[+-]?\d+$/.test(upper) ||
          BigInt(lower) < -2147483648n ||
          BigInt(upper) > 2147483647n ||
          BigInt(lower) > BigInt(upper)
        )
          fail("project.invalid", "array/dimension");
        return `${BigInt(lower)}..${BigInt(upper)}`;
      });
    if (!dimensions.length || dimensions.length > 3) fail("project.invalid", "array/dimension");
    return `ARRAY[${dimensions.join(", ")}] OF ${readType(required(choice, "baseType"))}`;
  }
  if (choice.name === "subrangeSigned" || choice.name === "subrangeUnsigned") {
    shape(choice, [], ["range", "baseType"]);
    const range = required(choice, "range");
    leaf(range, ["lower", "upper"]);
    const base = readType(required(choice, "baseType"));
    if (!isIntegerType(base) || !base.startsWith("U") !== (choice.name === "subrangeSigned"))
      fail("project.invalid", `${choice.name}/baseType`);
    for (const key of ["lower", "upper"])
      if (!/^[+-]?\d+$/.test(attribute(range, key)))
        fail("project.invalid", `${choice.name}/range/@${key}`);
    return `${base} (${BigInt(attribute(range, "lower"))}..${BigInt(attribute(range, "upper"))})`;
  }
  if (choice.name === "enum") {
    shape(choice, [], ["values", "baseType"]);
    const values = required(choice, "values");
    shape(values, [], ["value"]);
    const members = values.children
      .filter((child) => child.name === "value")
      .map((member) => {
        leaf(member, ["name", "value"]);
        const name = attribute(member, "name");
        validateIdentifier(name, "enum/value/@name");
        const value = member.attributes.value;
        if (value !== undefined && !/^[+-]?\d+$/.test(value))
          fail("project.invalid", "enum/value/@value");
        return `${name}${value === undefined ? "" : ` := ${value}`}`;
      });
    if (!members.length) fail("project.invalid", "enum/values");
    const baseType = one(choice, "baseType", false);
    const base = baseType ? readType(baseType) : "INT";
    if (!isIntegerType(base)) fail("project.invalid", "enum/baseType");
    return `${base} (${members.join(", ")})`;
  }
  if (choice.name === "string" || choice.name === "wstring") {
    leaf(choice, ["length"]);
    const length = choice.attributes.length;
    if (
      length !== undefined &&
      (!/^[0-9]+$/.test(length) || Number(length) < 1 || Number(length) > MAX_STRING_LENGTH)
    )
      fail("project.invalid", `${choice.name}/@length`);
    return choice.name.toUpperCase() + (length === undefined ? "" : `[${Number(length)}]`);
  }
  leaf(choice, choice.name === "derived" ? ["name"] : []);
  if (choice.name === "derived") {
    const name = attribute(choice, "name");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail("project.invalid", "derived/@name");
    return name.toUpperCase();
  }
  return choice.name.toUpperCase();
}

function readVariables(pou: XmlNode): VariableDeclaration[] {
  const intf = required(pou, "interface");
  shape(intf, [], ["returnType", "localVars", "inputVars", "outputVars", "tempVars", "inOutVars"]);
  const variables: VariableDeclaration[] = [];
  for (const group of intf.children.filter((child) =>
    ["localVars", "inputVars", "outputVars", "tempVars", "inOutVars"].includes(child.name),
  )) {
    shape(group, ["constant"], ["variable"]);
    const constant = group.attributes.constant;
    if (constant !== undefined && !["true", "false", "1", "0"].includes(constant))
      fail("project.invalid", `${group.name}/@constant`);
    for (const variable of group.children.filter((child) => child.name === "variable")) {
      shape(variable, ["name", "address"], ["type", "initialValue"]);
      const type = required(variable, "type");
      const initialValue = readInitialValue(variable);
      variables.push({
        section: group.name as VariableDeclaration["section"],
        ...(["true", "1"].includes(constant ?? "") ? { constant: true } : {}),
        name: attribute(variable, "name"),
        type: readType(type),
        ...(variable.attributes.address === undefined
          ? {}
          : { address: variable.attributes.address }),
        ...(initialValue === undefined ? {} : { initialValue }),
      });
    }
  }
  return variables;
}

function readCoordinates(header: XmlNode): void {
  const coordinates = required(header, "coordinateInfo");
  shape(coordinates, [], ["fbd", "ld", "sfc"]);
  for (const name of ["fbd", "ld", "sfc"]) {
    const language = required(coordinates, name);
    shape(language, [], ["scaling"]);
    const scaling = required(language, "scaling");
    leaf(scaling, ["x", "y"]);
    for (const axis of ["x", "y"]) {
      if (Number(attribute(scaling, axis)) !== 1)
        fail("project.unsupported", `coordinateInfo/${name}/scaling/@${axis}`);
    }
  }
}

function readExtensions(
  root: XmlNode,
  diagnostics: Diagnostic[],
): { panel: JsonValue; sources: Map<XmlNode, string> } {
  let panel: JsonValue = null;
  const sources = new Map<XmlNode, string>();
  const visit = (node: XmlNode): void => {
    const seen = new Set<string>();
    for (const child of node.children) {
      if (child.uri !== TC6_NAMESPACE || child.name !== "addData") {
        visit(child);
        continue;
      }
      shape(child, [], ["data"]);
      for (const data of child.children) {
        if (data.name !== "data") continue;
        const name = attribute(data, "name");
        for (const key of Object.keys(data.attributes)) {
          if (key !== "name" && key !== "handleUnknown")
            fail("project.unsupported", `addData/data/@${key}`);
        }
        if (
          !["preserve", "discard", "implementation"].includes(attribute(data, "handleUnknown")) ||
          data.children.length !== 1 ||
          data.text.trim()
        )
          fail("project.invalid", `addData/${name}`);
        const known =
          (node === root && (name === PANEL_NAMESPACE || name === SOURCE_NAMESPACE)) ||
          (node.uri === TC6_NAMESPACE &&
            ["pou", "dataType"].includes(node.name) &&
            name === SOURCE_NAMESPACE);
        if (!known) {
          diagnostics.push({ code: "project.dropped-data", severity: "warning", args: { name } });
          continue;
        }
        if (seen.has(name)) fail("project.invalid", `addData/${name}[2]`);
        seen.add(name);
        if (data.children.length !== 1) fail("project.invalid", `addData/${name}`);
        const payload = data.children[0]!;
        if (
          payload.uri !== name ||
          payload.name !== (name === PANEL_NAMESPACE ? "panel" : "source") ||
          payload.attributes.version !== "1" ||
          Object.keys(payload.attributes).length !== 1 ||
          payload.children.length
        ) {
          fail("project.unsupported", `addData/${name}`);
        }
        if (name === PANEL_NAMESPACE) {
          try {
            const parsed: unknown = JSON.parse(payload.text);
            if (!validJson(parsed)) fail("project.invalid", "addData/panel");
            panel = parsed;
          } catch {
            fail("project.invalid", "addData/panel");
          }
        } else sources.set(node, payload.text);
      }
    }
  };
  visit(root);
  return { panel, sources };
}

/** Malformed or unsupported input is returned as localizable diagnostics, never thrown. */
export function readProject(xml: string): ProjectResult<Project> {
  const diagnostics: Diagnostic[] = [];
  try {
    const root = parseXml(xml);
    if (root.name !== "project") fail("project.missing", "project");
    shape(root, [], ["fileHeader", "contentHeader", "types", "instances"]);
    const file = required(root, "fileHeader");
    leaf(file, [...fileRequired, ...fileOptional]);
    for (const key of fileRequired) attribute(file, key);
    dateTime(attribute(file, "creationDateTime"), "fileHeader/@creationDateTime");
    const header = required(root, "contentHeader");
    shape(header, ["name", ...contentOptional], ["coordinateInfo"]);
    attribute(header, "name");
    if (
      header.attributes.language !== undefined &&
      !/^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(header.attributes.language)
    )
      fail("project.invalid", "contentHeader/@language");
    if (header.attributes.modificationDateTime !== undefined)
      dateTime(header.attributes.modificationDateTime, "contentHeader/@modificationDateTime");
    readCoordinates(header);
    const types = required(root, "types");
    shape(types, [], ["dataTypes", "pous"]);
    const dataTypesNode = required(types, "dataTypes");
    shape(dataTypesNode, [], ["dataType"]);
    const pous = required(types, "pous");
    shape(pous, [], ["pou"]);
    const extensions = readExtensions(root, diagnostics);
    const dataTypeNodes = dataTypesNode.children.filter((child) => child.name === "dataType");
    const declarations = dataTypeNodes.map((node) => {
      shape(node, ["name"], ["baseType", "initialValue"]);
      const name = attribute(node, "name");
      validateIdentifier(name, "dataType/@name");
      const initialValue = readInitialValue(node);
      return {
        name,
        type: readType(required(node, "baseType"), true),
        ...(initialValue === undefined ? {} : { initialValue }),
      };
    });
    const canonicalTypes = declarations.map(joinDataType);
    const typeAsts = canonicalTypes.map(parseType);
    const resolved = resolveDataTypes(typeAsts);
    validateTypeInitializers(typeAsts);
    const dataTypes = declarations.map((_, index) => {
      // Normalize folded enum values and bounds before comparing preserved source.
      const normalized = splitDataType(canonicalTypes[index]!, typeAsts);
      let source = canonicalTypes[index]!;
      const preserved = extensions.sources.get(dataTypeNodes[index]!);
      if (preserved !== undefined) {
        let matches = false;
        try {
          matches =
            JSON.stringify(splitDataType(preserved, typeAsts)) === JSON.stringify(normalized);
        } catch {
          // Damaged or unrepresentable preserved text cannot override standard XML.
        }
        if (matches) source = preserved;
        else diagnostics.push({ code: "project.stale-source", severity: "warning", args: {} });
      }
      return source;
    });
    const pouNodes = pous.children.filter((child) => child.name === "pou");
    const programs = pouNodes.map((pou) => {
      shape(pou, ["name", "pouType"], ["interface", "body"]);
      const kind = attribute(pou, "pouType");
      if (kind !== "program" && kind !== "function" && kind !== "functionBlock")
        fail("project.unsupported", "pou/@pouType");
      const name = attribute(pou, "name");
      validateIdentifier(name, "pou/@name");
      const variables = readVariables(pou);
      const returnNode = one(required(pou, "interface"), "returnType", false);
      if (returnNode && kind !== "function") fail("project.invalid", "pou/interface/returnType");
      const returnType = returnNode ? readType(returnNode) : undefined;
      const bodyNode = required(pou, "body");
      shape(bodyNode, [], ["ST"]);
      const st = required(bodyNode, "ST");
      if (Object.keys(st.attributes).length) fail("project.unsupported", "body/ST/@attributes");
      // formattedText is exactly one XHTML element; markup inside it is outside our ST subset.
      if (st.children.length !== 1) fail("project.invalid", "body/ST");
      const text = st.children[0]!;
      if (
        text.uri !== XHTML_NAMESPACE ||
        text.name !== "p" ||
        text.children.length ||
        Object.keys(text.attributes).length
      )
        fail("project.unsupported", "body/ST/xhtml");
      if (st.text.trim()) fail("project.invalid", "body/ST/text()");
      const split: SplitProgram = {
        kind,
        name,
        ...(returnType === undefined ? {} : { returnType }),
        variables,
        body: text.text,
      };
      validateInitializers(split, resolved.types);
      let program = joinProgram(split);
      const parsed = splitProgram(program, resolved.types);
      if (!parsed.value) fail("project.invalid", "pou/interface");
      if (
        JSON.stringify(parsed.value) !==
        JSON.stringify({ ...split, body: canonicalBody(split.body) })
      ) {
        // Re-parsing must not allow XML attributes or initializer text to inject declarations.
        fail("project.invalid", "pou/interface");
      }
      const source =
        extensions.sources.get(pou) ??
        (pouNodes.length === 1 ? extensions.sources.get(root) : undefined);
      if (source !== undefined) {
        const preserved = splitProgram(source, resolved.types);
        if (preserved.value && JSON.stringify(preserved.value) === JSON.stringify(split))
          program = source;
        else diagnostics.push({ code: "project.stale-source", severity: "warning", args: {} });
      }
      return { split, source: program };
    });
    const instances = required(root, "instances");
    shape(instances, [], ["configurations"]);
    const configurations = required(instances, "configurations");
    shape(configurations, [], ["configuration"]);
    const configuration = required(configurations, "configuration");
    shape(configuration, ["name"], ["resource"]);
    const resource = required(configuration, "resource");
    shape(resource, ["name"], ["task"]);
    const task = required(resource, "task");
    shape(task, ["name", "interval", "priority"], ["pouInstance"]);
    const taskInterval = attribute(task, "interval");
    if (!interval(taskInterval)) fail("project.invalid", "task/@interval");
    const priorityText = attribute(task, "priority");
    const priority = Number(priorityText);
    if (
      !/^\+?\d+$/.test(priorityText) ||
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 65535
    )
      fail("project.invalid", "task/@priority");
    const instance = one(task, "pouInstance", false);
    let binding: Project["instance"];
    if (instance) {
      leaf(instance, ["name", "typeName"]);
      const typeName = attribute(instance, "typeName");
      if (
        !programs.some(
          ({ split }) =>
            split.kind === "program" && split.name.toUpperCase() === typeName.toUpperCase(),
        )
      )
        fail("project.invalid", "pouInstance/@typeName");
      validateIdentifier(attribute(instance, "name"), "pouInstance/@name");
      binding = { name: attribute(instance, "name"), typeName };
    }
    for (const node of [configuration, resource, task])
      validateIdentifier(attribute(node, "name"), `${node.name}/@name`);
    return {
      value: {
        fileHeader: { ...file.attributes } as unknown as FileHeader,
        contentHeader: { ...header.attributes } as unknown as ContentHeader,
        dataTypes,
        pous: programs.map(({ source }) => source),
        configuration: attribute(configuration, "name"),
        resource: attribute(resource, "name"),
        task: { name: attribute(task, "name"), interval: taskInterval, priority },
        ...(binding ? { instance: binding } : {}),
        panel: extensions.panel,
      },
      diagnostics,
    };
  } catch (error) {
    return {
      value: null,
      diagnostics: [
        ...diagnostics,
        error instanceof ProjectError
          ? error.diagnostic
          : { code: "project.invalid-xml", severity: "error", args: {} },
      ],
    };
  }
}

function typeXml(type: string): string {
  const array = /^ARRAY\[([^\]]+)\] OF (.+)$/.exec(type);
  if (array)
    return element(
      "array",
      {},
      array[1]!
        .split(",")
        .map((d) => {
          const [lower, upper] = d.trim().split("..");
          return element("dimension", { lower: lower!, upper: upper! });
        })
        .join("") + element("baseType", {}, typeXml(array[2]!)),
    );

  const string = /^(STRING|WSTRING)(?:\[([0-9]+)\])?$/.exec(type);
  if (string)
    return element(string[1]!.toLowerCase(), string[2] === undefined ? {} : { length: string[2] });
  const range = /^(\w+) \(([+-]?\d+)\.\.([+-]?\d+)\)$/.exec(type);
  if (range && isIntegerType(range[1]!))
    return element(
      !range[1]!.startsWith("U") ? "subrangeSigned" : "subrangeUnsigned",
      {},
      element("range", { lower: range[2]!, upper: range[3]! }) +
        element("baseType", {}, typeXml(range[1]!)),
    );
  const enumeration = /^(\w+) \((.*)\)$/.exec(type);
  if (enumeration)
    return element(
      "enum",
      {},
      element(
        "values",
        {},
        enumeration[2]!
          .split(", ")
          .map((member) => {
            const [name, value] = member.split(" := ");
            return element("value", { name: name!, value: value! });
          })
          .join(""),
      ) + element("baseType", {}, typeXml(enumeration[1]!)),
    );
  return elementaryTypes.has(type)
    ? element(type)
    : xmlTypes[type]
      ? element(xmlTypes[type]!)
      : element("derived", { name: type });
}

function sourceXml(source: string): string {
  return element(
    "data",
    { name: SOURCE_NAMESPACE, handleUnknown: "discard" },
    element("source:source", { version: "1" }, escapeXml(source)),
  );
}

function variableXml(variable: VariableDeclaration): string {
  return element(
    "variable",
    {
      name: variable.name,
      ...(variable.address === undefined ? {} : { address: variable.address }),
    },
    element("type", {}, typeXml(variable.type)) + initialXml(variable.initialValue),
  );
}

/** Validate through the same supported-subset reader before returning an XML document. */
export function writeProject(project: Project): ProjectResult<string> {
  let dataTypes: string;
  let resolved: ReturnType<typeof resolveDataTypes>;
  try {
    const asts = project.dataTypes.map(parseType);
    resolved = resolveDataTypes(asts);
    validateTypeInitializers(asts);
    dataTypes = project.dataTypes
      .map((source) => {
        const split = splitDataType(source, asts);
        return element(
          "dataType",
          { name: split.name },
          element("baseType", {}, typeXml(split.type)) +
            initialXml(split.initialValue) +
            element("addData", {}, sourceXml(source)),
        );
      })
      .join("");
  } catch (error) {
    return {
      value: null,
      diagnostics: [
        error instanceof ProjectError
          ? error.diagnostic
          : { code: "project.invalid", severity: "error", args: { path: "dataTypes" } },
      ],
    };
  }
  const programs: SplitProgram[] = [];
  for (const source of project.pous) {
    const parsed = splitProgram(source, resolved.types);
    if (!parsed.value) return { value: null, diagnostics: parsed.diagnostics };
    programs.push(parsed.value);
  }
  const coordinateInfo = element(
    "coordinateInfo",
    {},
    ["fbd", "ld", "sfc"]
      .map((name) => element(name, {}, element("scaling", { x: 1, y: 1 })))
      .join(""),
  );
  const pous = programs
    .map((program, index) => {
      let groups = "";
      let current: VariableDeclaration[] = [];
      const flush = () => {
        if (current.length)
          groups += element(
            current[0]!.section,
            current[0]!.constant ? { constant: "true" } : {},
            current.map(variableXml).join(""),
          );
        current = [];
      };
      for (const variable of program.variables) {
        if (
          current.length &&
          (current[0]!.section !== variable.section || current[0]!.constant !== variable.constant)
        )
          flush();
        current.push(variable);
      }
      flush();
      return element(
        "pou",
        { name: program.name, pouType: program.kind },
        element(
          "interface",
          {},
          (program.returnType === undefined
            ? ""
            : element("returnType", {}, typeXml(program.returnType))) + groups,
        ) +
          element("body", {}, element("ST", {}, element("xhtml:p", {}, escapeXml(program.body)))) +
          element("addData", {}, sourceXml(project.pous[index]!)),
      );
    })
    .join("");
  const firstProgram = programs.find((program) => program.kind === "program");
  const instance = firstProgram
    ? element("pouInstance", {
        name: project.instance?.name ?? "mainInstance",
        typeName: firstProgram.name,
      })
    : "";
  const task = element("task", project.task, instance);
  const configurations = element(
    "configurations",
    {},
    element(
      "configuration",
      { name: project.configuration },
      element("resource", { name: project.resource }, task),
    ),
  );
  let panel: string;
  try {
    if (!validJson(project.panel)) fail("project.invalid", "panel");
    panel = JSON.stringify(project.panel);
    if (panel === undefined) fail("project.invalid", "panel");
  } catch {
    return {
      value: null,
      diagnostics: [{ code: "project.invalid", severity: "error", args: { path: "panel" } }],
    };
  }
  const extra = element(
    "addData",
    {},
    element(
      "data",
      { name: PANEL_NAMESPACE, handleUnknown: "discard" },
      element("panel:panel", { version: "1" }, escapeXml(panel)),
    ),
  );
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    element(
      "project",
      {
        xmlns: TC6_NAMESPACE,
        "xmlns:xhtml": XHTML_NAMESPACE,
        "xmlns:panel": PANEL_NAMESPACE,
        "xmlns:source": SOURCE_NAMESPACE,
      },
      element("fileHeader", project.fileHeader) +
        element("contentHeader", project.contentHeader, coordinateInfo) +
        element("types", {}, element("dataTypes", {}, dataTypes) + element("pous", {}, pous)) +
        element("instances", {}, configurations) +
        extra,
    );
  const validation = readProject(xml);
  return { value: validation.value ? xml : null, diagnostics: validation.diagnostics };
}
