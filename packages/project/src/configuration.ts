import { check, lex, parsePou, parseConfiguration, type Token } from "@benchtop-plc/compiler";
import { splitProgram, joinProgram } from "./text.js";
import type { VariableDeclaration } from "./model.js";
import type { DataType, Diagnostic, TypeTable } from "@benchtop-plc/core";

export interface ConfigurationStructure {
  globals?: VariableDeclaration[];
  resourceGlobals?: VariableDeclaration[];
  name: string;
  resource: string;
  tasks: {
    name: string;
    interval?: string;
    single?: string;
    priority: number;
    instances: { name: string; typeName: string }[];
  }[];
}

export class ConfigurationError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.code);
  }
}

/** Exchange accepts representable declarations even before the compiler can run them. */
export function splitConfiguration(
  source: string,
  types: TypeTable = [],
  legacyNames = false,
): ConfigurationStructure {
  const scanned = lex(source, legacyNames);
  if (!scanned.tokens) throw new ConfigurationError(scanned.diagnostics[0]);
  const tokens = scanned.tokens;
  let cursor = 0;
  const current = () => tokens[cursor]!;
  const invalid = (path: string): never => {
    throw new ConfigurationError({ code: "project.invalid", severity: "error", args: { path } });
  };
  const take = () => tokens[cursor++]!;
  const expect = (key: string) => {
    if (current().key !== key)
      throw new ConfigurationError({
        code: "syntax.expected-token",
        severity: "error",
        span: current().span,
        args: { expected: key, found: current().text },
      });
    return take();
  };
  const identifier = (type = false) => {
    const token = current();
    // Reuse the POU parser's identifier/type rules, including reserved names.
    const parsed = parsePou(
      type
        ? `PROGRAM __INSTANCE VAR x : ${token.text}; END_VAR END_PROGRAM`
        : `PROGRAM ${token.text} END_PROGRAM`,
      legacyNames,
    );
    if (!parsed.ast) invalid("configuration/identifier");
    take();
    return token.text;
  };
  const scalar = (values: Token[], type: DataType): number | string => {
    const text = values.map((token) => token.text).join(" ");
    const ast = parsePou(
      `PROGRAM __TASK VAR x : ${type} := ${text}; END_VAR END_PROGRAM`,
      legacyNames,
    ).ast;
    if (!ast) return invalid(`task/${type}`);
    const result = check(ast);
    const value = result.checked?.symbols[0]?.initialValue;
    if (
      result.diagnostics.some((item) => item.severity === "error") ||
      (typeof value !== "number" && typeof value !== "string")
    )
      return invalid(`task/${type}`);
    return value;
  };
  const globalSections = (): string => {
    const sections: string[] = [];
    while (current().key === "VAR_GLOBAL") {
      const section: Token[] = [take()];
      while (current().key !== "END_VAR" && current().kind !== "eof") section.push(take());
      section.push(expect("END_VAR"));
      sections.push(
        "VAR " +
          section
            .slice(1)
            .map((t) => t.text)
            .join(" "),
      );
    }
    return sections.join(" ");
  };
  expect("CONFIGURATION");
  const name = identifier();
  const globalSource = globalSections();
  expect("RESOURCE");
  const resource = identifier();
  expect("ON");
  identifier(); // TC6 does not store the resource type.
  const resourceGlobalSource = globalSections();
  const tasks: ConfigurationStructure["tasks"] = [];
  const instances: { name: string; typeName: string; task?: string }[] = [];
  while (["TASK", "PROGRAM"].includes(current().key)) {
    if (current().key === "PROGRAM") {
      take();
      const instanceName = identifier();
      let task: string | undefined;
      if (current().key === "WITH") {
        take();
        task = identifier();
      }
      expect(":");
      let typeName = identifier(true);
      while (current().key === ".") {
        take();
        typeName += `.${identifier(true)}`;
      }
      if (current().key === "(") {
        const connectionTokens: Token[] = [];
        let depth = 0;
        do {
          const token = take();
          if (token.kind === "eof") return invalid("pouInstance/connections");
          connectionTokens.push(token);
          if (token.key === "(") depth++;
          if (token.key === ")") depth--;
        } while (depth > 0);
        // Connections live only in the exact source extension. Validate their syntax
        // with the compiler while leaving semantic errors exchangeable, as for POUs.
        const parsed = parseConfiguration(
          `CONFIGURATION C RESOURCE R ON Cpu
          TASK T (INTERVAL := T#10ms, PRIORITY := 0);
          PROGRAM A WITH T : Main ${connectionTokens.map((token) => token.text).join(" ")};
          END_RESOURCE END_CONFIGURATION`,
          legacyNames,
        );
        if (!parsed.ast || parsed.diagnostics.some((d) => d.severity === "error"))
          return invalid("pouInstance/connections");
      }
      expect(";");
      instances.push({ name: instanceName, typeName, task });
      continue;
    }
    take();
    const taskName = identifier();
    expect("(");
    const parameters = new Map<string, Token[]>();
    while (current().key !== ")") {
      const parameter = identifier().toUpperCase();
      if (!["INTERVAL", "SINGLE", "PRIORITY"].includes(parameter) || parameters.has(parameter))
        invalid("task/parameter");
      expect(":=");
      const values: Token[] = [];
      while (![",", ")", ""].includes(current().key)) values.push(take());
      if (!values.length) invalid("task/parameter");
      parameters.set(parameter, values);
      if (current().key !== ",") break;
      take();
      if (current().key === ")") invalid("task/parameter");
    }
    expect(")");
    expect(";");
    const interval = parameters.get("INTERVAL");
    const single = parameters.get("SINGLE");
    if (!!interval === !!single || !parameters.has("PRIORITY")) invalid("task/parameter");
    let trigger: { interval: string } | { single: string };
    if (interval) {
      if (interval.length !== 1 || interval[0]!.kind !== "time") invalid("task/interval");
      scalar(interval, interval[0]!.dataType === "LTIME" ? "LTIME" : "TIME");
      // Scalar storage truncates fractional milliseconds/nanoseconds. Exchange must
      // use the validated literal's exact duration so XML keeps its semantic errors.
      const nanoseconds = intervalNanoseconds(interval[0]!);
      if (nanoseconds <= 0n) invalid("task/interval");
      const seconds = nanoseconds / 1000000000n;
      const fraction = String(nanoseconds % 1000000000n)
        .padStart(9, "0")
        .replace(/0+$/, "");
      trigger = { interval: `PT${seconds}${fraction ? `.${fraction}` : ""}S` };
    } else {
      if (single!.length !== 1 || !["identifier", "address"].includes(single![0]!.kind))
        invalid("task/single");
      trigger = { single: single![0]!.text };
    }
    const priorityTokens = parameters.get("PRIORITY")!;
    const priority = Number(scalar(priorityTokens, priorityTokens[0]?.dataType ?? "UINT"));
    if (!Number.isInteger(priority) || priority < 0 || priority > 65535) invalid("task/priority");
    tasks.push({ name: taskName, ...trigger, priority, instances: [] });
  }
  expect("END_RESOURCE");
  expect("END_CONFIGURATION");
  expect("");
  // TC6 can only nest an instance in an existing task. Keep an invalid/missing
  // WITH in the exact source, and project that instance into the first XML task.
  for (const instance of instances) {
    const task =
      tasks.find((task) => task.name.toUpperCase() === instance.task?.toUpperCase()) ?? tasks[0];
    if (!task) return invalid("resource/pouInstance");
    task.instances.push({ name: instance.name, typeName: instance.typeName });
  }
  const combined = splitProgram(
    `PROGRAM __GLOBALS ${globalSource} ${resourceGlobalSource} END_PROGRAM`,
    types,
    undefined,
    legacyNames,
  );
  if (!combined.value) throw new ConfigurationError(combined.diagnostics[0]!);
  const count =
    parsePou(`PROGRAM __GLOBALS ${globalSource} END_PROGRAM`, legacyNames).ast?.declarations.reduce(
      (n, d) => n + d.names.length,
      0,
    ) ?? 0;
  return {
    name,
    resource,
    tasks,
    globals: combined.value.variables.slice(0, count),
    resourceGlobals: combined.value.variables.slice(count),
  };
}

/** Rebuild editable text when no matching source extension is available. */
export function joinConfiguration(configuration: ConfigurationStructure): string {
  const globalsText = (variables: VariableDeclaration[] = []): string => {
    const source = joinProgram({ kind: "program", name: "__GLOBALS", variables, body: "" });
    return source
      .replace(/^PROGRAM __GLOBALS\n?/, "")
      .replace(/END_PROGRAM\n$/, "")
      .replace(/^VAR(?= |$)/gm, "VAR_GLOBAL");
  };
  return [
    `CONFIGURATION ${configuration.name}`,
    globalsText(configuration.globals),
    `RESOURCE ${configuration.resource} ON BENCHTOP`,
    globalsText(configuration.resourceGlobals),
    ...configuration.tasks.map(
      (task) =>
        `TASK ${task.name} (${task.single === undefined ? `INTERVAL := ${durationLiteral(task.interval!)}` : `SINGLE := ${task.single}`}, PRIORITY := ${task.priority});`,
    ),
    ...configuration.tasks.flatMap((task) =>
      task.instances.map(
        (instance) => `PROGRAM ${instance.name} WITH ${task.name} : ${instance.typeName};`,
      ),
    ),
    "END_RESOURCE",
    "END_CONFIGURATION",
    "",
  ].join("\n");
}

/** The lexer has already validated unit order and scalar() has checked range. */
function intervalNanoseconds(token: Token): bigint {
  const text = token.text.slice(token.text.indexOf("#") + 1).replaceAll("_", "");
  const units: Record<string, bigint> = {
    d: 86400000000000n,
    h: 3600000000000n,
    m: 60000000000n,
    s: 1000000000n,
    ms: 1000000n,
    us: 1000n,
    ns: 1n,
  };
  let total = 0n;
  for (const part of text.matchAll(/(\d+)(?:\.(\d+))?(ms|us|ns|d|h|m|s)/gi)) {
    const fraction = part[2] ?? "";
    const scale = 10n ** BigInt(fraction.length);
    const numerator = BigInt(part[1]! + fraction) * units[part[3]!.toLowerCase()]!;
    if (numerator % scale !== 0n)
      throw new ConfigurationError({
        code: "project.invalid",
        severity: "error",
        args: { path: "task/interval" },
      });
    total += numerator / scale;
  }
  return text.startsWith("-") ? -total : total;
}

export function durationNanoseconds(value: string): bigint {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d+))?S)?)?$/.exec(value);
  if (!match || /[1-9]/.test((match[5] ?? "").slice(9)))
    throw new ConfigurationError({
      code: "project.invalid",
      severity: "error",
      args: { path: "task/@interval" },
    });
  return (
    (BigInt(match[1] ?? 0) * 86400n +
      BigInt(match[2] ?? 0) * 3600n +
      BigInt(match[3] ?? 0) * 60n +
      BigInt(match[4] ?? 0)) *
      1000000000n +
    BigInt((match[5] ?? "").slice(0, 9).padEnd(9, "0"))
  );
}

function durationLiteral(value: string): string {
  const nanoseconds = durationNanoseconds(value);
  return nanoseconds % 1000000n === 0n && nanoseconds <= 2147483647n * 1000000n
    ? `T#${nanoseconds / 1000000n}ms`
    : `LT#${nanoseconds}ns`;
}

/** Duration spellings in foreign XML may differ from the source's TIME literal. */
export function sameConfiguration(a: ConfigurationStructure, b: ConfigurationStructure): boolean {
  const normalize = (value: ConfigurationStructure) => ({
    name: value.name,
    resource: value.resource,
    globals: value.globals ?? [],
    resourceGlobals: value.resourceGlobals ?? [],
    tasks: value.tasks.map((task) => ({
      ...task,
      interval:
        task.interval === undefined ? undefined : durationNanoseconds(task.interval).toString(),
    })),
  });
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
