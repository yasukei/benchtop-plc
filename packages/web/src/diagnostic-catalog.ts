import { formatType, isFunctionBlockType, type TypeDescriptor } from "@benchtop-plc/core";
import type { Diagnostic, DiagnosticArgs, DiagnosticCode } from "@benchtop-plc/core";
import type { Language } from "./catalog.js";

/** A template receives only the arguments defined by core for its code. */
export type DiagnosticCatalog = {
  [C in DiagnosticCode]: (args: DiagnosticArgs[C]) => string;
};

const typeText = (value: TypeDescriptor | string | number | null): string =>
  typeof value === "object" && value !== null ? formatType(value) : String(value);

const enTokens: Record<string, string> = {
  identifier: "identifier",
  address: "direct address",
  eof: "end of input",
  expression: "expression",
};
const jaTokens: Record<string, string> = {
  integer: "整数",
  identifier: "識別子",
  address: "直接アドレス",
  eof: "入力の終わり",
  expression: "式",
};
const pouKinds: Record<string, string> = {
  program: "PROGRAM",
  function: "FUNCTION",
  functionBlock: "FUNCTION_BLOCK",
  class: "CLASS",
};
const enBounds = { from: "start", to: "end", step: "step" };
const jaBounds = { from: "開始値", to: "終了値", step: "増分" };

export const diagnosticEn = {
  "namespace.unknown": ({ name }) => `Unknown namespace or qualified name ${name}.`,
  "namespace.ambiguous": ({ name }) => `Name ${name} is ambiguous.`,
  "namespace.internal": ({ name }) => `Element ${name} is INTERNAL to another namespace.`,
  "namespace.internal-global": ({ name }) => `INTERNAL declaration ${name} requires a namespace.`,
  "interface.unknown": ({ name }) => `Interface ${name} is unknown.`,
  "interface.cycle": ({ name }) => `Interface inheritance through ${name} forms a cycle.`,
  "interface.signature": ({ name }) => `Inherited prototype ${name} has incompatible signatures.`,
  "interface.unimplemented": ({ name }) =>
    `A public implementation with the signature of ${name} is required.`,
  "interface.lifetime": () => "The interface target must have persistent instance storage.",
  "interface.assignment-attempt": () =>
    "Assignment attempt requires interface variables or references to user instances; the source may also be NULL.",

  "inheritance.unknown-base": ({ name }) => `Base type ${name} is unknown.`,
  "inheritance.base-kind": ({ name }) =>
    `Base ${name} must have the same kind as the derived type.`,
  "inheritance.cycle": ({ name }) => `Inheritance through ${name} forms a cycle.`,
  "inheritance.final-base": ({ name }) => `FINAL type ${name} cannot be extended.`,
  "inheritance.member-collision": ({ name }) => `Member ${name} redeclares an inherited member.`,
  "inheritance.override-required": ({ name }) => `Inherited method ${name} requires OVERRIDE.`,
  "inheritance.override-missing": ({ name }) => `OVERRIDE method ${name} has no base method.`,
  "inheritance.override-private": ({ name }) => `PRIVATE method ${name} cannot be overridden.`,
  "inheritance.override-final": ({ name }) => `FINAL method ${name} cannot be overridden.`,
  "inheritance.override-access": ({ name }) =>
    `Override ${name} must keep the base access specifier.`,
  "inheritance.override-signature": ({ name }) =>
    `Override ${name} must keep the base parameters and result type.`,
  "inheritance.abstract-instance": ({ name }) => `ABSTRACT type ${name} cannot be instantiated.`,
  "inheritance.abstract-method": ({ name }) =>
    `Abstract method ${name} requires an abstract type and an empty body.`,
  "inheritance.abstract-private": ({ name }) => `Abstract method ${name} cannot be PRIVATE.`,
  "inheritance.abstract-unimplemented": ({ name }) =>
    `Non-abstract type must implement abstract method ${name}.`,
  "inheritance.abstract-body": () => "An abstract function block must have no body statements.",
  "inheritance.modifier-conflict": () => "ABSTRACT and FINAL cannot be combined or repeated.",
  "inheritance.super-context": () => "SUPER requires a derived type context.",
  "inheritance.super-method": ({ name }) =>
    `SUPER method ${name} must exist and be concrete and accessible.`,
  "inheritance.super-body": () =>
    "SUPER() takes no arguments and is allowed only in a derived function block body.",
  "class.body": () => "A class has no body; put statements inside methods.",
  "class.not-callable": ({ name }) =>
    `Class instance ${name} cannot be called; call a method instead.`,
  "decl.retention-conflict": () => "RETAIN and NON_RETAIN cannot qualify the same section.",
  "decl.retention-section": () =>
    "Retention qualifiers are not allowed on VAR_TEMP, VAR_IN_OUT or VAR_EXTERNAL.",
  "decl.retention-function": () => "Retention qualifiers are not allowed in a FUNCTION.",
  "decl.retention-constant": () => "Retention qualifiers cannot be combined with CONSTANT.",
  "decl.retention-address": () =>
    "Retention qualifiers cannot be combined with a direct address or address connection.",

  "global.not-found": ({ name }) => `No global variable matches external ${name}.`,
  "global.type-mismatch": ({ name }) =>
    `External ${name} must have exactly the global variable's type.`,
  "global.constant-mismatch": ({ name }) =>
    `External ${name} must match the global variable's CONSTANT qualifier.`,
  "global.external-initializer": ({ name }) =>
    `External ${name} cannot have an initializer or a direct address.`,
  "config.configuration-count": () => `A project supports only one configuration.`,
  "config.resource-count": () => `A configuration requires exactly one resource.`,
  "config.task-count": () => `A resource requires 1 to 16 tasks.`,
  "config.no-instances": () => `A resource requires at least one program instance.`,
  "config.instance-limit": () => `A resource supports at most 64 program instances.`,
  "config.name-collision": ({ name }) =>
    `${name} conflicts with another configuration, resource, task, instance, POU, type or standard name.`,
  "config.unknown-task": ({ name }) => `Unknown task: ${name}.`,
  "config.missing-task": ({ name }) => `Program instance ${name} requires WITH and a task name.`,
  "config.program-type": ({ name }) => `${name} is not a known PROGRAM type.`,
  "config.interval": () =>
    `INTERVAL requires a TIME or LTIME literal from 10 ms to 1 h in whole multiples of 10 ms.`,
  "config.task-trigger": () => `A task requires exactly one of INTERVAL and SINGLE.`,
  "config.single": () =>
    `SINGLE requires a non-constant BOOL global or a supported %IX input address.`,
  "config.priority": () => `PRIORITY requires an integer literal from 0 to 65535.`,
  "config.connection-parameter": ({ name }) => `Unknown program parameter: ${name}.`,
  "config.connection-direction": ({ name }) =>
    `Incorrect connection direction for program parameter ${name}.`,
  "config.connection-duplicate": ({ name }) => `Program parameter ${name} is connected twice.`,
  "config.connection-target": ({ name }) =>
    `Invalid connection target for program parameter ${name}.`,
  "config.task-parameter": ({ name }) => `Unsupported or duplicate task parameter: ${name}.`,
  "runtime.halted": () => "Command rejected: the runtime is halted.",
  "runtime.not-halted": () => "Command rejected: the runtime is not halted.",
  "runtime.configured-cycle": () =>
    `Command rejected: edit the configuration source to change the task interval.`,
  "runtime.null-reference": () => "Cannot dereference NULL.",
  "type.invalid-reference-target": () =>
    "A reference requires a compatible variable with persistent storage.",
  "type.reference-initializer": () => "A reference initializer must be NULL.",
  "project.invalid-xml": () => "Invalid XML, a DTD, or excessive XML nesting.",
  "project.missing": ({ path }) => `Required project data is missing: ${path}.`,
  "project.unsupported": ({ path }) => `Unsupported project data: ${path}.`,
  "project.invalid": ({ path }) => `Invalid project data: ${path}.`,
  "project.dropped-data": ({ name }) => `Unknown vendor data was dropped: ${name}.`,
  "project.stale-source": () =>
    "Preserved editor text differs from the XML. Canonical text was imported.",
  "lex.unterminated-string": () => "Unterminated string literal or line break inside a literal.",
  "lex.invalid-string-escape": () => "Invalid string escape.",
  "lex.invalid-string-character": () => "Single-byte literal contains a character above 16#FF.",
  "lex.unterminated-comment": () => "Block comment has no closing delimiter.",
  "lex.invalid-character": ({ character }) => `Invalid character: ${character}.`,
  "lex.malformed-direct-address": ({ address }) => `Malformed direct address: ${address}.`,
  "lex.malformed-number": ({ literal }) => `Malformed numeric literal: ${literal}.`,
  "syntax.expected-token": ({ expected, found }) =>
    `Expected ${enTokens[expected] ?? expected}; found ${typeText(found)}.`,
  "syntax.expected-identifier": ({ found }) => `Expected an identifier; found ${typeText(found)}.`,
  "syntax.reserved-identifier": ({ name }) =>
    `Reserved word ${name} cannot be used as an identifier.`,
  "syntax.unsupported-construct": ({ construct }) => `Construct ${construct} is not supported.`,
  "syntax.assignment-operator": () => "Assignment requires := instead of =.",
  "syntax.unexpected-eof": () => "Unexpected end of input.",
  "syntax.missing-end": ({ expected }) => `Missing ${expected}.`,
  "syntax.nesting-limit": ({ limit }) => `Source nesting exceeds the limit of ${limit} levels.`,
  "syntax.tree-depth-limit": ({ limit }) =>
    `Source syntax tree exceeds the depth limit of ${limit} levels.`,
  "decl.unknown-type": ({ name }) => `Unknown type: ${name}.`,
  "decl.type-cycle": ({ name }) =>
    `Type ${name} has a containment or alias cycle; use REF_TO for recursive links.`,
  "decl.fb-array-form": ({ form }) =>
    form === "named"
      ? "Named function block array types are not supported; declare the instance array directly in a PROGRAM or FUNCTION_BLOCK VAR section."
      : "Function block instances are not supported inside nested array types; use a multidimensional instance array instead.",
  "decl.structure-member-type": ({ name }) =>
    isFunctionBlockType(name.toUpperCase())
      ? `Function block type ${name} is not supported in a structure.`
      : `Function block or class type ${name} is not supported in a structure.`,
  "decl.duplicate": ({ name }) => `Duplicate declaration: ${name}.`,
  "decl.name-collision": ({ name, kind }) =>
    `${name} conflicts with a ${kind === "type" ? "type" : "function"} name.`,
  "decl.direct-address-type": ({ name, type }) =>
    `Type ${typeText(type)} does not fit the direct address on ${name}.`,
  "decl.temp-address": () => "Temporary variables cannot have direct addresses.",
  "decl.parameter-address": () =>
    "PROGRAM parameters cannot declare direct addresses. Connect them in the configuration instead.",
  "decl.at-multiple-names": () => "AT cannot apply to multiple declared names.",
  "decl.output-overlap": ({ address, other }) => `Output writers overlap: ${address} and ${other}.`,
  "decl.address-out-of-range": ({ address }) => `Address is outside supported I/O: ${address}.`,
  "decl.nonconstant-initializer": ({ name }) =>
    `Initializer for ${name} must be a constant expression.`,
  "decl.fb-initializer": ({ name }) =>
    `Function block or class instance ${name} cannot have an initializer.`,
  "decl.constant-section": ({ section }) => `CONSTANT is allowed only on VAR; found ${section}.`,
  "decl.constant-type": () => `CONSTANT requires an elementary type.`,
  "decl.constant-address": () => `CONSTANT cannot be combined with AT.`,
  "decl.constant-not-writable": ({ name }) => `Constant ${name} cannot be written.`,
  "decl.constant-order": ({ name }) =>
    `Constant ${name} must be declared and initialized earlier in this POU.`,
  "decl.open-array-section": () =>
    "Open arrays are allowed only as direct VAR_IN_OUT parameters, with every dimension open.",
  "decl.in-out-initializer": ({ name }) =>
    `In-out parameter ${name} cannot have an initializer; its value comes from the caller's variable.`,
  "pou.duplicate": ({ name }) => `Duplicate POU: ${name}.`,
  "pou.name-collision": ({ name }) => `POU ${name} conflicts with a standard name.`,
  "pou.program-count": ({ found }) =>
    `Without a configuration source a project requires exactly one PROGRAM; found ${typeText(found)}. Add a configuration source to run several programs.`,
  "pou.unsupported-kind": ({ name }) => `User function block ${name} is not supported yet.`,
  "pou.invalid-section": ({ section, kind }) =>
    `${section} is not supported in a ${pouKinds[kind] ?? kind} POU.`,
  "pou.direct-address": () => "Direct addresses are allowed only in the PROGRAM.",
  "pou.function-block-in-function": () =>
    "A function or method cannot declare a function block or class instance.",
  "access.duplicate": () => "Only one access specifier is allowed.",
  "access.invalid-section": () => "An access specifier is not allowed on this section.",
  "access.hidden": ({ name }) => `Member or method ${name} is inaccessible here.`,
  "method.invalid-owner": () => "Methods can only be declared in a function block or class.",
  "method.name-collision": ({ name }) =>
    `Method or local name ${name} conflicts with an instance member or method.`,
  "method.unknown": ({ name }) => `Unknown method ${name}.`,
  "method.instance-in-out": ({ name }) => `Instance VAR_IN_OUT ${name} is unavailable in methods.`,
  "method.this-outside": () => "THIS requires a function block or class context.",
  "method.this-call": () => "A method cannot call the instance body through THIS.",
  "pou.recursion": ({ name }) => `Recursive call to ${name}.`,
  "call.program": ({ name }) => `PROGRAM ${name} cannot be called.`,
  "call.no-result": ({ name }) =>
    `Function ${name} has no result and cannot be used in an expression.`,
  "call.in-out-variable": () =>
    "An in-out argument must be a writable variable, array element or structure member of the caller.",
  "call.in-out-type": ({ from, to }) =>
    `An in-out argument must have exactly type ${typeText(to)}, received ${typeText(from)}.`,
  "call.missing-in-out": ({ name, parameter }) =>
    `${name} requires in-out parameter ${parameter} on every call.`,
  "call.formal-required": ({ name }) =>
    `Function ${name} requires named parameters because it has outputs or in-outs.`,
  "name.undeclared": ({ name }) => `Undeclared identifier: ${name}.`,
  "type.unknown-structure-member": ({ type, member }) =>
    `${typeText(type)} has no member ${member}.`,
  "type.not-array": ({ type }) => `Cannot index ${typeText(type)}; an array is required.`,
  "type.array-index-count": ({ expected, found }) =>
    `Array access requires ${expected} indices; found ${found}.`,
  "type.array-index-not-integer": ({ type }) =>
    `Array index must have an integer type; found ${typeText(type)}.`,
  "type.array-initializer-required": ({ type }) =>
    `Use an array initializer list [...] for ${typeText(type)}.`,
  "type.invalid-bit-access": ({ type, bit }) =>
    `Bit ${bit} is outside the width of ${typeText(type)}, or the type does not support bit access.`,
  "type.portability": ({ function: name }) =>
    name.endsWith("_TO_BOOL")
      ? `${name} returns the rightmost bit; some vendor runtimes return TRUE for any non-zero value.`
      : `${name} reinterprets the bit pattern; some vendor runtimes convert the numeric value instead.`,
  "type.invalid-constant": () => "Invalid constant or value outside the supported range.",
  "type.case-label-not-constant": () => "CASE label must be an integer constant expression.",
  "fb.invalid-instance-section": ({ name }) =>
    `Function block or class instance ${name} must be declared in VAR.`,
  "fb.duplicate-input": ({ name, member }) => `Input ${name}.${member} is supplied more than once.`,
  "type.assign-mismatch": ({ from, to, hint }) =>
    `Cannot assign ${typeText(from)} to ${typeText(to)}.${hint === "explicit-conversion" ? " Use an explicit conversion." : ""}`,
  "type.operand-mismatch": ({ operator, left, right }) =>
    right === null
      ? `Operator ${operator} does not accept ${typeText(left)}.`
      : `Operator ${operator} does not accept ${typeText(left)} and ${typeText(right)}.`,
  "type.condition-not-bool": ({ statement }) => `${statement} condition must be BOOL.`,
  "type.case-selector-not-integer": ({ type }) =>
    `CASE selector must be an integer; found ${typeText(type)}.`,
  "type.case-label-not-integer": ({ type }) =>
    `CASE label must be an integer; found ${typeText(type)}.`,
  "type.for-variable-not-integer": ({ name, type }) =>
    `FOR variable ${name} must be an integer; found ${typeText(type)}.`,
  "type.for-variable-subrange": ({ name, type }) =>
    `FOR variable ${name} has subrange type ${typeText(type)}, which is not supported as a loop control variable; use an unrestricted integer variable.`,
  "type.for-bound-not-integer": ({ bound, type }) =>
    `FOR ${enBounds[bound]} must be an integer; found ${typeText(type)}.`,
  "flow.exit-outside-loop": () => "EXIT must be inside a loop.",
  "fb.not-function-block": ({ name }) => `${name} is not a function block instance.`,
  "fb.no-matching-variant": ({ name, types }) =>
    `No timer or counter variant for ${name} accepts these preset types: ${types.map(formatType).join(", ")}.`,
  "fb.unknown-member": ({ name, member }) => `Unknown function block member: ${name}.${member}.`,
  "fb.output-not-writable": ({ name, member }) =>
    `Function block output ${name}.${member} is not writable.`,
  "fb.instance-as-value": ({ name }) =>
    `Function block instance ${name} cannot be used as a scalar value.`,
  "fb.unsupported-call": ({ name }) =>
    `Function block ${name} requires named := inputs; positional arguments are unsupported.`,
  "fb.call-in-expression": ({ name }) =>
    `Function block call ${name} cannot be used in an expression.`,
  "call.unknown-function": ({ name }) => `Unknown function: ${name}.`,
  "call.invalid-parameter": ({ name, parameter }) =>
    `${name}: unknown, duplicate or incorrectly directed parameter ${parameter}.`,
  "call.argument-count": ({ name, min, max, found }) =>
    max === null
      ? `${name} requires at least ${min} arguments; found ${typeText(found)}.`
      : `${name} requires ${min === max ? min : `${min}–${max}`} arguments; found ${typeText(found)}.`,
  "call.argument-type": ({ name, index, expected, found }) =>
    `Argument ${index + 1} of ${name} requires ${expected.map(formatType).join(" / ")}; found ${typeText(found)}.`,
  "runtime.index-out-of-range": ({ index, lower, upper }) =>
    `Array index ${index} is outside ${lower}..${upper}.`,
  "runtime.subrange-violation": ({ value, lower, upper }) =>
    `Value ${value} is outside subrange ${lower}..${upper}.`,
  "type.ambiguous-enumeration": ({ name }) =>
    `Enumeration value ${name} must be qualified because a variable has the same name.`,
  "runtime.load-failed": () => "The program could not be loaded. Apply it again to retry.",
  "runtime.internal-error": () =>
    "An internal error stopped the runtime. Acknowledge the fault or reset, then load the program again.",
  "runtime.input-address": () =>
    "Command rejected: the input address is invalid or outside the input image.",
  "runtime.input-value": () =>
    "Command rejected: the input value does not match the address or its type's range.",
  "runtime.unsupported-cycle": () => "Command rejected: the cycle interval is not supported.",
  "runtime.invalid-value": () => "Non-finite result or REAL overflow.",
  "runtime.division-by-zero": () => "Division by zero.",
  "runtime.watchdog": ({ limit }) => `Loop iteration limit (${limit}) exceeded.`,
  "runtime.for-by-zero": () => "FOR step must not be zero.",
  "runtime.debug-target": () =>
    "Command rejected: select a scalar variable from the loaded program.",
  "runtime.debug-type-mismatch": ({ from, to }) =>
    `Command rejected: cannot write a value of type ${typeText(from)} to a variable of type ${typeText(to)}.`,
  "runtime.debug-value": () => "Command rejected: the value is invalid or out of range.",
  "runtime.write-input-mapped": ({ name }) =>
    `Command rejected: cannot write input-mapped variable ${name}. Use force instead.`,
  "runtime.write-connected-input": ({ name }) =>
    `Command rejected: cannot write connected input ${name}. Use force instead.`,
} satisfies DiagnosticCatalog;

export const diagnosticJa = {
  "namespace.unknown": ({ name }) => `名前空間または修飾名${name}が見つかりません。`,
  "namespace.ambiguous": ({ name }) => `名前${name}は曖昧です。`,
  "namespace.internal": ({ name }) => `${name}は別の名前空間のINTERNAL要素です。`,
  "namespace.internal-global": ({ name }) => `INTERNAL宣言${name}には名前空間が必要です。`,
  "interface.unknown": ({ name }) => `インターフェース${name}が見つかりません。`,
  "interface.cycle": ({ name }) => `インターフェース${name}の継承が循環しています。`,
  "interface.signature": ({ name }) => `継承したプロトタイプ${name}のシグネチャが一致しません。`,
  "interface.unimplemented": ({ name }) => `${name}と同じシグネチャのPUBLICメソッドが必要です。`,
  "interface.lifetime": () => "インターフェースの参照先には永続的なインスタンス領域が必要です。",
  "interface.assignment-attempt": () =>
    "代入試行にはインターフェース変数またはユーザーインスタンスへの参照が必要です。代入元にはNULLも指定できます。",

  "inheritance.unknown-base": ({ name }) => `基底型${name}が見つかりません。`,
  "inheritance.base-kind": ({ name }) => `基底型${name}は派生型と同じ種類である必要があります。`,
  "inheritance.cycle": ({ name }) => `${name}を介した継承が循環しています。`,
  "inheritance.final-base": ({ name }) => `FINAL型${name}は継承できません。`,
  "inheritance.member-collision": ({ name }) =>
    `メンバー${name}は継承されたメンバーと重複しています。`,
  "inheritance.override-required": ({ name }) =>
    `継承されたメソッド${name}にはOVERRIDEが必要です。`,
  "inheritance.override-missing": ({ name }) =>
    `OVERRIDEメソッド${name}に対応する基底メソッドがありません。`,
  "inheritance.override-private": ({ name }) =>
    `PRIVATEメソッド${name}はオーバーライドできません。`,
  "inheritance.override-final": ({ name }) => `FINALメソッド${name}はオーバーライドできません。`,
  "inheritance.override-access": ({ name }) =>
    `オーバーライド${name}のアクセス指定子は基底メソッドと一致する必要があります。`,
  "inheritance.override-signature": ({ name }) =>
    `オーバーライド${name}の引数と戻り値の型は基底メソッドと一致する必要があります。`,
  "inheritance.abstract-instance": ({ name }) =>
    `ABSTRACT型${name}のインスタンスは宣言できません。`,
  "inheritance.abstract-method": ({ name }) =>
    `抽象メソッド${name}には抽象型と空の本体が必要です。`,
  "inheritance.abstract-private": ({ name }) => `抽象メソッド${name}はPRIVATEにできません。`,
  "inheritance.abstract-unimplemented": ({ name }) =>
    `具象型は抽象メソッド${name}を実装する必要があります。`,
  "inheritance.abstract-body": () => "抽象ファンクションブロックの本体に文は記述できません。",
  "inheritance.modifier-conflict": () => "ABSTRACTとFINALは併用または重複できません。",
  "inheritance.super-context": () => "SUPERには派生型のコンテキストが必要です。",
  "inheritance.super-method": ({ name }) =>
    `SUPERのメソッド${name}は存在し、具象かつアクセス可能である必要があります。`,
  "inheritance.super-body": () =>
    "SUPER()は引数を取らず、派生ファンクションブロックの本体内でのみ使用できます。",
  "class.body": () => "クラスには本体を記述できません。文はメソッド内に記述してください。",
  "class.not-callable": ({ name }) =>
    `クラスのインスタンス ${name} は呼び出せません。メソッドを呼び出してください。`,
  "decl.retention-conflict": () => "同じセクションに RETAIN と NON_RETAIN は指定できません。",
  "decl.retention-section": () =>
    "VAR_TEMP、VAR_IN_OUT、VAR_EXTERNAL に保持修飾子は指定できません。",
  "decl.retention-function": () => "FUNCTION に保持修飾子は指定できません。",
  "decl.retention-constant": () => "保持修飾子と CONSTANT は併用できません。",
  "decl.retention-address": () => "保持修飾子と直接アドレスまたはアドレス接続は併用できません。",

  "global.not-found": ({ name }) => `外部変数 ${name} に対応するグローバル変数がありません。`,
  "global.type-mismatch": ({ name }) =>
    `外部変数 ${name} の型はグローバル変数の型と一致する必要があります。`,
  "global.constant-mismatch": ({ name }) =>
    `外部変数 ${name} の CONSTANT 指定はグローバル変数と一致する必要があります。`,
  "global.external-initializer": ({ name }) =>
    `外部変数 ${name} に初期値や直接アドレスは指定できません。`,
  "config.configuration-count": () => `プロジェクトで使用できる構成は1つです。`,
  "config.resource-count": () => `構成にはリソースが1つ必要です。`,
  "config.task-count": () => `リソースには1個から16個のタスクが必要です。`,
  "config.no-instances": () => `リソースにはプログラムインスタンスが必要です。`,
  "config.instance-limit": () => `プログラムインスタンスは64個までです。`,
  "config.name-collision": ({ name }) =>
    `${name}は構成、リソース、タスク、インスタンス、POU、型または標準の名前と衝突しています。`,
  "config.unknown-task": ({ name }) => `不明なタスクです: ${name}。`,
  "config.missing-task": ({ name }) =>
    `プログラムインスタンス${name}にはWITHとタスク名が必要です。`,
  "config.program-type": ({ name }) => `${name}は定義済みのPROGRAM型ではありません。`,
  "config.interval": () =>
    `INTERVALには10msから1時間までの10ms単位のTIMEまたはLTIMEリテラルが必要です。`,
  "config.task-trigger": () => `タスクにはINTERVALかSINGLEのどちらか一方が必要です。`,
  "config.single": () =>
    `SINGLEには定数でないBOOLグローバル変数または対応する%IX入力アドレスが必要です。`,
  "config.priority": () => `PRIORITYには0から65535までの整数リテラルが必要です。`,
  "config.connection-parameter": ({ name }) => `不明なプログラムパラメーターです: ${name}。`,
  "config.connection-direction": ({ name }) =>
    `プログラムパラメーター ${name} の接続方向が正しくありません。`,
  "config.connection-duplicate": ({ name }) =>
    `プログラムパラメーター ${name} が重複して接続されています。`,
  "config.connection-target": ({ name }) => `プログラムパラメーター ${name} の接続先が無効です。`,
  "config.task-parameter": ({ name }) => `未対応または重複したタスクパラメーターです: ${name}。`,
  "runtime.halted": () => "操作を拒否しました。実行は中断中です。",
  "runtime.not-halted": () => "操作を拒否しました。実行は中断されていません。",
  "runtime.configured-cycle": () =>
    `操作を拒否しました。タスク周期を変更するには構成ソースを編集してください。`,
  "runtime.null-reference": () => "NULLを逆参照できません。",
  "type.invalid-reference-target": () => "参照には互換性のある永続変数が必要です。",
  "type.reference-initializer": () => "参照の初期値はNULLにしてください。",
  "project.invalid-xml": () => "XMLが不正、DTDが存在、またはXMLの入れ子が深すぎます。",
  "project.missing": ({ path }) => `必須のプロジェクトデータがありません: ${path}。`,
  "project.unsupported": ({ path }) => `未対応のプロジェクトデータです: ${path}。`,
  "project.invalid": ({ path }) => `プロジェクトデータが不正です: ${path}。`,
  "project.dropped-data": ({ name }) => `不明なベンダーデータを破棄しました: ${name}。`,
  "project.stale-source": () =>
    "保存されたエディターテキストがXMLと異なるため、標準形式のテキストを読み込みました。",
  "lex.unterminated-string": () => "文字列リテラルが閉じられていないか、改行が含まれています。",
  "lex.invalid-string-escape": () => "文字列のエスケープが不正です。",
  "lex.invalid-string-character": () => "単一バイト文字列に16#FFを超える文字が含まれています。",
  "lex.unterminated-comment": () => "ブロックコメントの終了記号がありません。",
  "lex.invalid-character": ({ character }) => `不正な文字です: ${character}。`,
  "lex.malformed-direct-address": ({ address }) => `直接アドレスの構文が不正です: ${address}。`,
  "lex.malformed-number": ({ literal }) => `数値リテラルの構文が不正です: ${literal}。`,
  "syntax.expected-token": ({ expected, found }) =>
    `${jaTokens[expected] ?? expected}が必要ですが、${typeText(found)}が見つかりました。`,
  "syntax.expected-identifier": ({ found }) =>
    `識別子が必要ですが、${typeText(found)}が見つかりました。`,
  "syntax.reserved-identifier": ({ name }) => `予約語${name}は識別子に使用できません。`,
  "syntax.unsupported-construct": ({ construct }) => `構文${construct}はサポートされていません。`,
  "syntax.assignment-operator": () => "代入には=ではなく:=が必要です。",
  "syntax.unexpected-eof": () => "入力が途中で終了しています。",
  "syntax.missing-end": ({ expected }) => `${expected}がありません。`,
  "syntax.nesting-limit": ({ limit }) => `ソースの入れ子が上限の${limit}段を超えています。`,
  "syntax.tree-depth-limit": ({ limit }) => `ソース構文木の深さが上限の${limit}段を超えています。`,
  "decl.unknown-type": ({ name }) => `不明な型です: ${name}。`,
  "decl.type-cycle": ({ name }) =>
    `型${name}の包含関係または別名定義が循環しています。再帰的なリンクにはREF_TOを使用してください。`,
  "decl.fb-array-form": ({ form }) =>
    form === "named"
      ? "ファンクションブロックの配列に名前付きの型は使用できません。PROGRAM または FUNCTION_BLOCK の VAR セクションで配列を直接宣言してください。"
      : "入れ子の配列型にはファンクションブロックを含められません。多次元のインスタンス配列を使用してください。",
  "decl.structure-member-type": ({ name }) =>
    isFunctionBlockType(name.toUpperCase())
      ? `${name} はファンクションブロック型のため、構造体のメンバーには使用できません。`
      : `${name} はファンクションブロックまたはクラス型のため、構造体のメンバーには使用できません。`,
  "decl.duplicate": ({ name }) => `宣言が重複しています: ${name}。`,
  "decl.name-collision": ({ name, kind }) =>
    `${name}は${kind === "type" ? "型" : "関数"}の名前と衝突しています。`,
  "decl.direct-address-type": ({ name, type }) =>
    `${name}の直接アドレスに型${typeText(type)}は対応していません。`,
  "decl.temp-address": () => "一時変数に直接アドレスは指定できません。",
  "decl.parameter-address": () =>
    "PROGRAMのパラメーター宣言に直接アドレスは指定できません。コンフィグレーションで接続してください。",
  "decl.at-multiple-names": () => "ATを複数の宣言名に適用することはできません。",
  "decl.output-overlap": ({ address, other }) =>
    `出力への書き込みが重複しています: ${address}、${other}。`,
  "decl.address-out-of-range": ({ address }) => `対応するI/Oの範囲外のアドレスです: ${address}。`,
  "decl.nonconstant-initializer": ({ name }) => `${name}の初期値には定数式が必要です。`,
  "decl.fb-initializer": ({ name }) =>
    `ファンクションブロックまたはクラスのインスタンス${name}には初期値を指定できません。`,
  "decl.constant-section": ({ section }) => `CONSTANT は VAR でのみ使用できます: ${section}。`,
  "decl.constant-type": () => `CONSTANT には基本データ型が必要です。`,
  "decl.constant-address": () => `CONSTANT と AT は併用できません。`,
  "decl.constant-not-writable": ({ name }) => `定数 ${name} には書き込めません。`,
  "decl.constant-order": ({ name }) =>
    `定数 ${name} は同じ POU 内で先に宣言・初期化する必要があります。`,
  "decl.open-array-section": () =>
    "可変長配列は VAR_IN_OUT 引数に直接宣言し、すべての次元を * にする必要があります。",
  "decl.in-out-initializer": ({ name }) =>
    `入出力パラメーター${name}には初期値を指定できません。値は呼び出し元の変数から取得します。`,
  "pou.duplicate": ({ name }) => `POUが重複しています: ${name}。`,
  "pou.name-collision": ({ name }) => `POU ${name}は標準の名前と衝突しています。`,
  "pou.program-count": ({ found }) =>
    `構成ソースがないプロジェクトにはPROGRAMが1つ必要ですが、${typeText(found)}個です。複数のプログラムを実行するには構成ソースを追加してください。`,
  "pou.unsupported-kind": ({ name }) => `ユーザー定義ファンクションブロック${name}は未対応です。`,
  "pou.invalid-section": ({ section, kind }) =>
    `${pouKinds[kind] ?? kind}のPOUでは${section}は未対応です。`,
  "pou.direct-address": () => "直接アドレスはPROGRAMでのみ使用できます。",
  "pou.function-block-in-function": () =>
    "関数やメソッドではファンクションブロックまたはクラスのインスタンスを宣言できません。",
  "access.duplicate": () => "アクセス指定子は1つだけ指定できます。",
  "access.invalid-section": () => "このセクションにアクセス指定子は指定できません。",
  "access.hidden": ({ name }) => `メンバーまたはメソッド${name}にはここからアクセスできません。`,
  "method.invalid-owner": () =>
    "メソッドはファンクションブロックまたはクラス内でのみ宣言できます。",
  "method.name-collision": ({ name }) =>
    `メソッドまたはローカル変数${name}がインスタンスのメンバーまたはメソッドと重複しています。`,
  "method.unknown": ({ name }) => `不明なメソッド${name}です。`,
  "method.instance-in-out": ({ name }) =>
    `インスタンスのVAR_IN_OUT ${name}はメソッド内では使用できません。`,
  "method.this-outside": () => "THISはファンクションブロックまたはクラス内でのみ使用できます。",
  "method.this-call": () => "THISでインスタンス本体を呼び出すことはできません。",
  "pou.recursion": ({ name }) => `${name}への再帰呼び出しです。`,
  "call.program": ({ name }) => `PROGRAM ${name}は呼び出せません。`,
  "call.no-result": ({ name }) => `関数${name}には戻り値がないため、式の中で使用できません。`,
  "call.in-out-variable": () =>
    "入出力引数には呼び出し元の書き込み可能な変数、配列要素、構造体メンバーが必要です。",
  "call.in-out-type": ({ from, to }) =>
    `入出力引数の型は厳密に ${typeText(to)} でなければなりません（実際の型: ${typeText(from)}）。`,
  "call.missing-in-out": ({ name, parameter }) =>
    `${name} の呼び出しには毎回入出力パラメーター ${parameter} が必要です。`,
  "call.formal-required": ({ name }) =>
    `関数${name}には出力または入出力があるため、名前付きパラメーターが必要です。`,
  "name.undeclared": ({ name }) => `宣言されていない識別子です: ${name}。`,
  "type.unknown-structure-member": ({ type, member }) =>
    `${typeText(type)} にメンバー ${member} はありません。`,
  "type.not-array": ({ type }) => `${typeText(type)} に添字は使えません。配列が必要です。`,
  "type.array-index-count": ({ expected, found }) =>
    `配列の添字は ${expected} 個必要です。${found} 個指定されています。`,
  "type.array-index-not-integer": ({ type }) =>
    `配列の添字は整数型でなければなりません。${typeText(type)} が指定されています。`,
  "type.array-initializer-required": ({ type }) =>
    `${typeText(type)} の初期値には配列の初期化リスト [...] を指定してください。`,
  "type.invalid-bit-access": ({ type, bit }) =>
    `${typeText(type)}のビット${bit}は範囲外、またはビットアクセス非対応の型です。`,
  "type.portability": ({ function: name }) =>
    name.endsWith("_TO_BOOL")
      ? `${name}は最下位ビットを返します。一部のベンダーの実行環境では、ゼロ以外のすべての値に対してTRUEを返します。`
      : `${name}はビットパターンを再解釈します。一部のベンダーの実行環境では、代わりに数値を変換します。`,
  "type.invalid-constant": () => "定数が不正、または値が対応範囲外です。",
  "type.case-label-not-constant": () => "CASEラベルには整数の定数式が必要です。",
  "fb.invalid-instance-section": ({ name }) =>
    `ファンクションブロックまたはクラスのインスタンス${name}はVARで宣言してください。`,
  "fb.duplicate-input": ({ name, member }) => `入力${name}.${member}が複数回指定されています。`,
  "type.assign-mismatch": ({ from, to, hint }) =>
    `${typeText(from)}を${typeText(to)}に代入することはできません。${hint === "explicit-conversion" ? "明示的な型変換を使用してください。" : ""}`,
  "type.operand-mismatch": ({ operator, left, right }) =>
    right === null
      ? `演算子${operator}は${typeText(left)}を受け付けません。`
      : `演算子${operator}は${typeText(left)}と${typeText(right)}を受け付けません。`,
  "type.condition-not-bool": ({ statement }) => `${statement}の条件にはBOOLが必要です。`,
  "type.case-selector-not-integer": ({ type }) =>
    `CASEの選択式には整数が必要ですが、${typeText(type)}です。`,
  "type.case-label-not-integer": ({ type }) =>
    `CASEラベルには整数が必要ですが、${typeText(type)}です。`,
  "type.for-variable-not-integer": ({ name, type }) =>
    `FOR変数${name}には整数が必要ですが、${typeText(type)}です。`,
  "type.for-variable-subrange": ({ name, type }) =>
    `FOR変数${name}の部分範囲型${typeText(type)}はループ制御変数として使用できません。部分範囲のない整数変数を使用してください。`,
  "type.for-bound-not-integer": ({ bound, type }) =>
    `FORの${jaBounds[bound]}には整数が必要ですが、${typeText(type)}です。`,
  "flow.exit-outside-loop": () => "EXITはループ内で使用してください。",
  "fb.not-function-block": ({ name }) =>
    `${name}はファンクションブロックのインスタンスではありません。`,
  "fb.no-matching-variant": ({ name, types }) =>
    `${name}のプリセット型に適合するタイマーまたはカウンターがありません: ${types.map(formatType).join(", ")}。`,
  "fb.unknown-member": ({ name, member }) =>
    `不明なファンクションブロックのメンバーです: ${name}.${member}。`,
  "fb.output-not-writable": ({ name, member }) =>
    `ファンクションブロックの出力${name}.${member}には書き込めません。`,
  "fb.instance-as-value": ({ name }) =>
    `ファンクションブロックのインスタンス${name}はスカラー値として使用できません。`,
  "fb.unsupported-call": ({ name }) =>
    `ファンクションブロック${name}の入力は名前付きの:=で指定してください。位置引数には対応していません。`,
  "fb.call-in-expression": ({ name }) =>
    `ファンクションブロックの呼び出し${name}は式の中で使用できません。`,
  "call.unknown-function": ({ name }) => `不明な関数です: ${name}。`,
  "call.invalid-parameter": ({ name, parameter }) =>
    `${name}: パラメーター ${parameter} が不明、重複、または方向が正しくありません。`,
  "call.argument-count": ({ name, min, max, found }) =>
    max === null
      ? `${name}には${min}個以上の引数が必要ですが、${typeText(found)}個です。`
      : `${name}には${min === max ? min : `${min}～${max}`}個の引数が必要ですが、${typeText(found)}個です。`,
  "call.argument-type": ({ name, index, expected, found }) =>
    `${name}の${index + 1}番目の引数には${expected.map(formatType).join(" / ")}が必要ですが、${typeText(found)}です。`,
  "runtime.index-out-of-range": ({ index, lower, upper }) =>
    `配列の添字 ${index} は範囲 ${lower}..${upper} の外です。`,
  "runtime.subrange-violation": ({ value, lower, upper }) =>
    `値 ${value} は部分範囲 ${lower}..${upper} の範囲外です。`,
  "type.ambiguous-enumeration": ({ name }) =>
    `同名の変数があるため、列挙値 ${name} には型名の修飾が必要です。`,
  "runtime.load-failed": () => "プログラムを読み込めませんでした。再度適用してやり直してください。",
  "runtime.internal-error": () =>
    "内部エラーでランタイムが停止しました。異常確認またはリセット後、プログラムを再度読み込んでください。",
  "runtime.input-address": () =>
    "コマンドを拒否しました。入力アドレスが無効か、入力イメージの範囲外です。",
  "runtime.input-value": () =>
    "コマンドを拒否しました。入力値がアドレスまたは型の範囲に適合しません。",
  "runtime.unsupported-cycle": () => "コマンドを拒否しました。この周期はサポートされていません。",
  "runtime.invalid-value": () => "非有限の計算結果、またはREALのオーバーフローが発生しました。",
  "runtime.division-by-zero": () => "ゼロによる除算が発生しました。",
  "runtime.watchdog": ({ limit }) => `ループの反復回数の上限（${limit}回）を超えました。`,
  "runtime.for-by-zero": () => "FORの増分をゼロにすることはできません。",
  "runtime.debug-target": () =>
    "操作を拒否しました。読み込み済みプログラムのスカラー変数を選択してください。",
  "runtime.debug-type-mismatch": ({ from, to }) =>
    `操作を拒否しました。${typeText(to)}型の変数に${typeText(from)}型の値は書き込めません。`,
  "runtime.debug-value": () => "操作を拒否しました。値が無効か範囲外です。",
  "runtime.write-input-mapped": ({ name }) =>
    `操作を拒否しました。入力変数${name}には書き込めません。強制設定を使用してください。`,
  "runtime.write-connected-input": ({ name }) =>
    `操作を拒否しました。接続された入力 ${name} には書き込めません。強制設定を使用してください。`,
} satisfies DiagnosticCatalog;

export const diagnosticCatalogs: Record<Language, DiagnosticCatalog> = {
  en: diagnosticEn,
  ja: diagnosticJa,
};

export function formatDiagnostic<C extends DiagnosticCode>(
  language: Language,
  diagnostic: Diagnostic<C>,
): string {
  // The mapped catalog preserves the code/argument relationship, even for a union of codes.
  const template = diagnosticCatalogs[language][diagnostic.code] as (
    args: DiagnosticArgs[C],
  ) => string;
  const message = template(diagnostic.args);
  return diagnostic.instance ? `${diagnostic.pou} (${diagnostic.instance}): ${message}` : message;
}
