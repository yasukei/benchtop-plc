import { isStandardFunction, isFunctionBlockType } from "@benchtop-plc/core";
import type { CyclicTaskIR, Diagnostic, SourceSpan } from "@benchtop-plc/core";
import type { Identifier, Program } from "./ast.js";
import { FrontendError, joinedSpan } from "./diagnostic.js";
import { exactNumber } from "./exact.js";
import { lex, isElementaryTypeName } from "./lexer.js";
import type { Token } from "./lexer.js";
import { isReservedStandardName } from "./reserved-names.js";

export interface Configuration {
  name: Identifier;
  resource: Identifier;
  task: CyclicTaskIR;
  taskName: Identifier;
  programs: { name: Identifier; type: Identifier; task?: Identifier }[];
  span: SourceSpan;
}

/** Existing project fields supply the implicit configuration, without adding a source. */
export interface ImplicitConfiguration {
  name?: string;
  resource?: string;
  task?: Partial<CyclicTaskIR>;
  instance?: string;
}

class ConfigurationParser {
  private cursor = 0;
  private name?: string;
  readonly diagnostics: Diagnostic[] = [];
  constructor(private readonly tokens: Token[]) {}
  private get current(): Token {
    return this.tokens[this.cursor]!;
  }
  private take(): Token {
    const token = this.current;
    if (token.kind !== "eof") this.cursor++;
    return token;
  }
  private report(diagnostic: Diagnostic): void {
    this.diagnostics.push({ ...diagnostic, pou: this.name });
  }
  private error(
    code: "config.configuration-count" | "config.resource-count" | "config.task-count",
    token = this.current,
  ): never {
    throw new FrontendError({ code, severity: "error", span: token.span, args: {} });
  }
  private expect(key: string): Token {
    if (this.current.key !== key)
      throw new FrontendError({
        code: "syntax.expected-token",
        severity: "error",
        span: this.current.span,
        args: { expected: key, found: this.current.text },
      });
    return this.take();
  }
  private identifier(allowType = false): Identifier {
    const token = this.current;
    if (token.kind !== "identifier" && !(allowType && isElementaryTypeName(token.key)))
      throw new FrontendError(
        token.kind === "keyword" || token.kind === "boolean"
          ? {
              code: "syntax.reserved-identifier",
              severity: "error",
              span: token.span,
              args: { name: token.text },
            }
          : {
              code: "syntax.expected-identifier",
              severity: "error",
              span: token.span,
              args: { found: token.text },
            },
      );
    this.take();
    return { name: token.text, key: token.key, span: token.span };
  }
  private at(key: string): boolean {
    return this.current.key === key;
  }
  private task(): { name: Identifier; intervalMs: number; priority: number } {
    this.expect("TASK");
    const name = this.identifier();
    this.expect("(");
    const parameters = new Map<string, Token[]>();
    while (this.current.key !== ")") {
      const parameter = this.identifier();
      this.expect(":=");
      const values: Token[] = [];
      while (![",", ")"].includes(this.current.key) && this.current.kind !== "eof") {
        // Do not swallow the next parameter when its separating comma is missing.
        if (this.current.kind === "identifier" && this.tokens[this.cursor + 1]?.key === ":=")
          this.expect(",");
        values.push(this.take());
      }
      if (parameters.has(parameter.key) || !["INTERVAL", "PRIORITY"].includes(parameter.key))
        this.report({
          code: "config.task-parameter",
          severity: "error",
          span: parameter.span,
          args: { name: parameter.name },
        });
      parameters.set(parameter.key, values);
      if (this.current.key !== ",") break;
      this.take();
    }
    this.expect(")");
    this.expect(";");
    const interval = parameters.get("INTERVAL") ?? [];
    let intervalMs = NaN;
    if (interval.length === 1 && interval[0]!.kind === "time") {
      // Calculate exact milliseconds; binary64 must not round a fractional interval into range.
      const text = interval[0]!.text.split("#")[1]!.replaceAll("_", "");
      const units: Record<string, bigint> = {
        d: 86400000000000n,
        h: 3600000000000n,
        m: 60000000000n,
        s: 1000000000n,
        ms: 1000000n,
        us: 1000n,
        ns: 1n,
      };
      let n = 0n,
        d = 1n;
      try {
        for (const part of text.matchAll(/([+-]?\d+(?:\.\d+)?)(ms|us|ns|d|h|m|s)/gi)) {
          const value = exactNumber(part[1]!);
          n = n * value.d + value.n * units[part[2]!.toLowerCase()]! * d;
          d *= value.d;
        }
        if (!text.startsWith("-") && n > 0n && n % (d * 10000000n) === 0n)
          intervalMs = Number(n / (d * 1000000n));
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 3600000)
      this.report({
        code: "config.interval",
        severity: "error",
        span: interval[0]?.span ?? name.span,
        args: {},
      });
    const priorityTokens = parameters.get("PRIORITY") ?? [];
    let priority = NaN;
    if (priorityTokens.length === 1 && priorityTokens[0]!.kind === "integer") {
      const token = priorityTokens[0]!;
      try {
        const value = exactNumber(
          token.dataType ? token.text.slice(token.text.indexOf("#") + 1) : token.text,
        );
        if (value.d === 1n) priority = Number(value.n);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    }
    if (!Number.isInteger(priority) || priority < 0 || priority > 65535)
      this.report({
        code: "config.priority",
        severity: "error",
        span: priorityTokens[0]?.span ?? name.span,
        args: {},
      });
    return { name, intervalMs, priority };
  }
  parse(): Configuration {
    const start = this.expect("CONFIGURATION");
    const name = this.identifier();
    this.name = name.name;
    if (this.current.key !== "RESOURCE") {
      if (["END_CONFIGURATION", "CONFIGURATION"].includes(this.current.key))
        this.error("config.resource-count");
    }
    this.expect("RESOURCE");
    const resource = this.identifier();
    this.expect("ON");
    this.identifier();
    if (!this.at("TASK")) this.error("config.task-count");
    const task = this.task();
    const programs: Configuration["programs"] = [];
    while (this.at("PROGRAM")) {
      this.take();
      const instance = this.identifier();
      let binding: Identifier | undefined;
      if (this.at("WITH")) {
        this.take();
        binding = this.identifier();
      } else
        this.report({
          code: "config.missing-task",
          severity: "error",
          span: instance.span,
          args: { name: instance.name },
        });
      this.expect(":");
      const type = this.identifier(true);
      this.expect(";");
      programs.push({ name: instance, type, task: binding });
    }
    if (this.current.key === "TASK") this.error("config.task-count");
    this.expect("END_RESOURCE");
    if (this.current.key === "RESOURCE") this.error("config.resource-count");
    const end = this.expect("END_CONFIGURATION");
    if (this.current.key === "CONFIGURATION") this.error("config.configuration-count");
    this.expect("");
    return {
      name,
      resource,
      taskName: task.name,
      task: { name: task.name.name, intervalMs: task.intervalMs, priority: task.priority },
      programs,
      span: joinedSpan(start.span, end.span),
    };
  }
}

export function parseConfiguration(source: string): {
  ast?: Configuration;
  diagnostics: Diagnostic[];
} {
  const scanned = lex(source);
  if (!scanned.tokens) return { diagnostics: scanned.diagnostics };
  const parser = new ConfigurationParser(scanned.tokens);
  try {
    return { ast: parser.parse(), diagnostics: parser.diagnostics };
  } catch (error) {
    if (!(error instanceof FrontendError)) throw error;
    const header = scanned.tokens[1];
    return {
      diagnostics: [
        ...parser.diagnostics,
        { ...error.diagnostic, ...(header?.kind === "identifier" ? { pou: header.text } : {}) },
      ],
    };
  }
}

export function checkConfiguration(
  config: Configuration,
  pous: ReadonlyMap<string, Program>,
  typeNames: Iterable<string>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const report = (diagnostic: Diagnostic) =>
    diagnostics.push({ ...diagnostic, pou: config.name.name });
  const names = new Set([...pous.keys(), ...typeNames]);
  const taskName = config.taskName;
  for (const name of [
    config.name,
    config.resource,
    taskName,
    ...config.programs.map((p) => p.name),
  ]) {
    if (
      names.has(name.key) ||
      isElementaryTypeName(name.key) ||
      isReservedStandardName(name.key) ||
      isStandardFunction(name.key) ||
      isFunctionBlockType(name.key)
    )
      report({
        code: "config.name-collision",
        severity: "error",
        span: name.span,
        args: { name: name.name },
      });
    names.add(name.key);
  }
  if (!config.programs.length)
    report({
      code: "config.no-instances",
      severity: "error",
      span: config.resource.span,
      args: {},
    });
  if (config.programs.length > 64)
    report({
      code: "config.instance-limit",
      severity: "error",
      span: config.programs[64]!.name.span,
      args: {},
    });
  for (const instance of config.programs) {
    if (instance.task && instance.task.key !== taskName.key)
      report({
        code: "config.unknown-task",
        severity: "error",
        span: instance.task.span,
        args: { name: instance.task.name },
      });
    if (pous.get(instance.type.key)?.kind !== "program")
      report({
        code: "config.program-type",
        severity: "error",
        span: instance.type.span,
        args: { name: instance.type.name },
      });
  }
  return diagnostics;
}
