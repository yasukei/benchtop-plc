import { check, parsePou } from "@benchtop-plc/compiler";
import type { Diagnostic } from "@benchtop-plc/core";
import type {
  ContentHeader,
  FileHeader,
  JsonValue,
  Project,
  ProjectResult,
  SplitProgram,
  VariableDeclaration,
} from "./model.js";
import { canonicalBody, joinProgram, splitProgram } from "./text.js";
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

function validateInitializers(program: SplitProgram): void {
  const ast = parsePou(joinProgram(program)).ast;
  if (!ast) fail("project.invalid", "pou/interface");
  // Check declarations together in their POU context; body/name/section errors do not block exchange.
  const result = check({ ...ast, body: [] });
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
          (item.span.line > span.line ||
            (item.span.line === span.line && item.span.column >= span.column)) &&
          (item.span.endLine < span.endLine ||
            (item.span.endLine === span.endLine && item.span.endColumn <= span.endColumn)),
      )
    )
      fail("project.invalid", `variable/${declaration.names[0].name}/initialValue`);
  }
}

function readType(type: XmlNode): string {
  shape(type, [], [...elementaryTypes, "string", "wstring", "derived"]);
  const choices = type.children.filter((child) => child.name !== "addData");
  if (choices.length !== 1) fail("project.invalid", `${type.name}/type`);
  const choice = choices[0]!;
  leaf(choice, choice.name === "derived" ? ["name"] : []);
  return choice.name === "derived"
    ? attribute(choice, "name").toUpperCase()
    : choice.name.toUpperCase();
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
      const initial = one(variable, "initialValue", false);
      let initialValue: string | undefined;
      if (initial) {
        shape(initial, [], ["simpleValue"]);
        const simple = required(initial, "simpleValue");
        leaf(simple, ["value"]);
        initialValue = attribute(simple, "value");
      }
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
          (node.uri === TC6_NAMESPACE && node.name === "pou" && name === SOURCE_NAMESPACE);
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
    const dataTypes = required(types, "dataTypes");
    shape(dataTypes, [], []);
    const pous = required(types, "pous");
    shape(pous, [], ["pou"]);
    const extensions = readExtensions(root, diagnostics);
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
      validateInitializers(split);
      let program = joinProgram(split);
      const parsed = splitProgram(program);
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
        const preserved = splitProgram(source);
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
    element("type", {}, typeXml(variable.type)) +
      (variable.initialValue === undefined
        ? ""
        : element("initialValue", {}, element("simpleValue", { value: variable.initialValue }))),
  );
}

/** Validate through the same supported-subset reader before returning an XML document. */
export function writeProject(project: Project): ProjectResult<string> {
  const programs: SplitProgram[] = [];
  for (const source of project.pous) {
    const parsed = splitProgram(source);
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
        element("types", {}, element("dataTypes") + element("pous", {}, pous)) +
        element("instances", {}, configurations) +
        extra,
    );
  const validation = readProject(xml);
  return { value: validation.value ? xml : null, diagnostics: validation.diagnostics };
}
