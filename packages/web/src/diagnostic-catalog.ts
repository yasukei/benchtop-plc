import type { Diagnostic, DiagnosticArgs, DiagnosticCode } from "@benchtop-plc/core";
import type { Language } from "./catalog.js";

/** A template receives only the arguments defined by core for its code. */
export type DiagnosticCatalog = {
  [C in DiagnosticCode]: (args: DiagnosticArgs[C]) => string;
};

const enTokens: Record<string, string> = {
  identifier: "identifier",
  address: "direct address",
  eof: "end of input",
  expression: "expression",
};
const jaTokens: Record<string, string> = {
  identifier: "識別子",
  address: "直接アドレス",
  eof: "入力の終わり",
  expression: "式",
};
const pouKinds: Record<string, string> = {
  program: "PROGRAM",
  function: "FUNCTION",
  functionBlock: "FUNCTION_BLOCK",
};
const enBounds = { from: "start", to: "end", step: "step" };
const jaBounds = { from: "開始値", to: "終了値", step: "増分" };

export const diagnosticEn = {
  "project.invalid-xml": () => "Invalid XML, a DTD, or excessive XML nesting.",
  "project.missing": ({ path }) => `Required project data is missing: ${path}.`,
  "project.unsupported": ({ path }) => `Unsupported project data: ${path}.`,
  "project.invalid": ({ path }) => `Invalid project data: ${path}.`,
  "project.dropped-data": ({ name }) => `Unknown vendor data was dropped: ${name}.`,
  "project.stale-source": () =>
    "Preserved editor text differs from the XML. Canonical text was imported.",
  "lex.unterminated-comment": () => "Block comment has no closing delimiter.",
  "lex.invalid-character": ({ character }) => `Invalid character: ${character}.`,
  "lex.malformed-direct-address": ({ address }) => `Malformed direct address: ${address}.`,
  "lex.malformed-number": ({ literal }) => `Malformed numeric literal: ${literal}.`,
  "syntax.expected-token": ({ expected, found }) =>
    `Expected ${enTokens[expected] ?? expected}; found ${found}.`,
  "syntax.expected-identifier": ({ found }) => `Expected an identifier; found ${found}.`,
  "syntax.reserved-identifier": ({ name }) =>
    `Reserved word ${name} cannot be used as an identifier.`,
  "syntax.assignment-operator": () => "Assignment requires := instead of =.",
  "syntax.unexpected-eof": () => "Unexpected end of input.",
  "syntax.missing-end": ({ expected }) => `Missing ${expected}.`,
  "decl.unknown-type": ({ name }) => `Unknown type: ${name}.`,
  "decl.duplicate": ({ name }) => `Duplicate declaration: ${name}.`,
  "decl.name-collision": ({ name, kind }) =>
    `${name} conflicts with a ${kind === "type" ? "type" : "function"} name.`,
  "decl.direct-address-type": ({ name, type }) =>
    `Direct address on ${name} requires BOOL; found ${type}.`,
  "decl.at-multiple-names": () => "AT cannot apply to multiple declared names.",
  "decl.address-out-of-range": ({ address }) => `Address is outside supported I/O: ${address}.`,
  "decl.nonconstant-initializer": ({ name }) =>
    `Initializer for ${name} must be a constant expression.`,
  "decl.fb-initializer": ({ name }) =>
    `Function block instance ${name} cannot have an initializer.`,
  "pou.duplicate": ({ name }) => `Duplicate POU: ${name}.`,
  "pou.name-collision": ({ name }) => `POU ${name} conflicts with a standard name.`,
  "pou.program-count": ({ found }) => `A project requires exactly one PROGRAM; found ${found}.`,
  "pou.unsupported-kind": ({ name }) => `User function block ${name} is not supported yet.`,
  "pou.invalid-section": ({ section, kind }) =>
    `${section} is not supported in a ${pouKinds[kind] ?? kind} POU.`,
  "pou.direct-address": () => "Direct addresses are allowed only in the PROGRAM.",
  "pou.function-block-in-function": () => "A function cannot declare a function block instance.",
  "pou.recursion": ({ name }) => `Recursive call to ${name}.`,
  "call.program": ({ name }) => `PROGRAM ${name} cannot be called.`,
  "call.no-result": ({ name }) =>
    `Function ${name} has no result and cannot be used in an expression.`,
  "call.formal-required": ({ name }) =>
    `Function ${name} requires named parameters because it has outputs.`,
  "name.undeclared": ({ name }) => `Undeclared identifier: ${name}.`,
  "type.invalid-bit-access": ({ type, bit }) =>
    `Bit ${bit} is outside the width of ${type}, or the type does not support bit access.`,
  "type.portability": ({ function: name }) =>
    name.endsWith("_TO_BOOL")
      ? `${name} returns the rightmost bit; some vendor runtimes return TRUE for any non-zero value.`
      : `${name} reinterprets the bit pattern; some vendor runtimes convert the numeric value instead.`,
  "type.invalid-constant": () => "Invalid constant or numeric value outside the supported range.",
  "type.case-label-not-constant": () => "CASE label must be an integer constant expression.",
  "fb.duplicate-input": ({ name, member }) => `Input ${name}.${member} is supplied more than once.`,
  "type.assign-mismatch": ({ from, to, hint }) =>
    `Cannot assign ${from} to ${to}.${hint === "explicit-conversion" ? " Use an explicit conversion." : ""}`,
  "type.operand-mismatch": ({ operator, left, right }) =>
    right === null
      ? `Operator ${operator} does not accept ${left}.`
      : `Operator ${operator} does not accept ${left} and ${right}.`,
  "type.condition-not-bool": ({ statement }) => `${statement} condition must be BOOL.`,
  "type.case-selector-not-integer": ({ type }) =>
    `CASE selector must be an integer; found ${type}.`,
  "type.case-label-not-integer": ({ type }) => `CASE label must be an integer; found ${type}.`,
  "type.for-variable-not-integer": ({ name, type }) =>
    `FOR variable ${name} must be an integer; found ${type}.`,
  "type.for-bound-not-integer": ({ bound, type }) =>
    `FOR ${enBounds[bound]} must be an integer; found ${type}.`,
  "flow.exit-outside-loop": () => "EXIT must be inside a loop.",
  "fb.not-function-block": ({ name }) => `${name} is not a function block instance.`,
  "fb.unknown-member": ({ name, member }) => `Unknown function block member: ${name}.${member}.`,
  "fb.output-not-writable": ({ name, member }) =>
    `Function block output ${name}.${member} is not writable.`,
  "fb.instance-as-value": ({ name }) =>
    `Function block instance ${name} cannot be used as a scalar value.`,
  "fb.unsupported-call": ({ name }) =>
    `Function block ${name} requires named := inputs; positional arguments and => outputs are unsupported.`,
  "fb.call-in-expression": ({ name }) =>
    `Function block call ${name} cannot be used in an expression.`,
  "call.unknown-function": ({ name }) => `Unknown function: ${name}.`,
  "call.invalid-parameter": ({ name, parameter }) =>
    `${name}: unknown, duplicate or incorrectly directed parameter ${parameter}.`,
  "call.argument-count": ({ name, min, max, found }) =>
    max === null
      ? `${name} requires at least ${min} arguments; found ${found}.`
      : `${name} requires ${min === max ? min : `${min}–${max}`} arguments; found ${found}.`,
  "call.argument-type": ({ name, index, expected, found }) =>
    `Argument ${index + 1} of ${name} requires ${expected.join(" / ")}; found ${found}.`,
  "runtime.invalid-value": () => "Non-finite result or REAL overflow.",
  "runtime.division-by-zero": () => "Division by zero.",
  "runtime.watchdog": ({ limit }) => `Loop iteration limit (${limit}) exceeded.`,
  "runtime.for-by-zero": () => "FOR step must not be zero.",
  "runtime.debug-target": () =>
    "Command rejected: select a scalar variable from the loaded program.",
  "runtime.debug-type-mismatch": ({ from, to }) =>
    `Command rejected: cannot write a value of type ${from} to a variable of type ${to}.`,
  "runtime.debug-value": () => "Command rejected: the value is invalid or out of range.",
  "runtime.write-input-mapped": ({ name }) =>
    `Command rejected: cannot write input-mapped variable ${name}. Use force instead.`,
} satisfies DiagnosticCatalog;

export const diagnosticJa = {
  "project.invalid-xml": () => "XMLが不正、DTDが存在、またはXMLの入れ子が深すぎます。",
  "project.missing": ({ path }) => `必須のプロジェクトデータがありません: ${path}。`,
  "project.unsupported": ({ path }) => `未対応のプロジェクトデータです: ${path}。`,
  "project.invalid": ({ path }) => `プロジェクトデータが不正です: ${path}。`,
  "project.dropped-data": ({ name }) => `不明なベンダーデータを破棄しました: ${name}。`,
  "project.stale-source": () =>
    "保存されたエディターテキストがXMLと異なるため、標準形式のテキストを読み込みました。",
  "lex.unterminated-comment": () => "ブロックコメントの終了記号がありません。",
  "lex.invalid-character": ({ character }) => `不正な文字です: ${character}。`,
  "lex.malformed-direct-address": ({ address }) => `直接アドレスの構文が不正です: ${address}。`,
  "lex.malformed-number": ({ literal }) => `数値リテラルの構文が不正です: ${literal}。`,
  "syntax.expected-token": ({ expected, found }) =>
    `${jaTokens[expected] ?? expected}が必要ですが、${found}が見つかりました。`,
  "syntax.expected-identifier": ({ found }) => `識別子が必要ですが、${found}が見つかりました。`,
  "syntax.reserved-identifier": ({ name }) => `予約語${name}は識別子に使用できません。`,
  "syntax.assignment-operator": () => "代入には=ではなく:=が必要です。",
  "syntax.unexpected-eof": () => "入力が途中で終了しています。",
  "syntax.missing-end": ({ expected }) => `${expected}がありません。`,
  "decl.unknown-type": ({ name }) => `不明な型です: ${name}。`,
  "decl.duplicate": ({ name }) => `宣言が重複しています: ${name}。`,
  "decl.name-collision": ({ name, kind }) =>
    `${name}は${kind === "type" ? "型" : "関数"}の名前と衝突しています。`,
  "decl.direct-address-type": ({ name, type }) =>
    `${name}の直接アドレスにはBOOLが必要ですが、${type}です。`,
  "decl.at-multiple-names": () => "ATを複数の宣言名に適用することはできません。",
  "decl.address-out-of-range": ({ address }) => `対応するI/Oの範囲外のアドレスです: ${address}。`,
  "decl.nonconstant-initializer": ({ name }) => `${name}の初期値には定数式が必要です。`,
  "decl.fb-initializer": ({ name }) =>
    `ファンクションブロックのインスタンス${name}には初期値を指定できません。`,
  "pou.duplicate": ({ name }) => `POUが重複しています: ${name}。`,
  "pou.name-collision": ({ name }) => `POU ${name}は標準の名前と衝突しています。`,
  "pou.program-count": ({ found }) => `プロジェクトにはPROGRAMが1つ必要ですが、${found}個です。`,
  "pou.unsupported-kind": ({ name }) => `ユーザー定義ファンクションブロック${name}は未対応です。`,
  "pou.invalid-section": ({ section, kind }) =>
    `${pouKinds[kind] ?? kind}のPOUでは${section}は未対応です。`,
  "pou.direct-address": () => "直接アドレスはPROGRAMでのみ使用できます。",
  "pou.function-block-in-function": () =>
    "関数ではファンクションブロックのインスタンスを宣言できません。",
  "pou.recursion": ({ name }) => `${name}への再帰呼び出しです。`,
  "call.program": ({ name }) => `PROGRAM ${name}は呼び出せません。`,
  "call.no-result": ({ name }) => `関数${name}には戻り値がないため、式の中で使用できません。`,
  "call.formal-required": ({ name }) =>
    `関数${name}には出力があるため、名前付きパラメーターが必要です。`,
  "name.undeclared": ({ name }) => `宣言されていない識別子です: ${name}。`,
  "type.invalid-bit-access": ({ type, bit }) =>
    `${type}のビット${bit}は範囲外、またはビットアクセス非対応の型です。`,
  "type.portability": ({ function: name }) =>
    name.endsWith("_TO_BOOL")
      ? `${name}は最下位ビットを返します。一部のベンダーの実行環境では、ゼロ以外のすべての値に対してTRUEを返します。`
      : `${name}はビットパターンを再解釈します。一部のベンダーの実行環境では、代わりに数値を変換します。`,
  "type.invalid-constant": () => "定数が不正、または数値が対応範囲外です。",
  "type.case-label-not-constant": () => "CASEラベルには整数の定数式が必要です。",
  "fb.duplicate-input": ({ name, member }) => `入力${name}.${member}が複数回指定されています。`,
  "type.assign-mismatch": ({ from, to, hint }) =>
    `${from}を${to}に代入することはできません。${hint === "explicit-conversion" ? "明示的な型変換を使用してください。" : ""}`,
  "type.operand-mismatch": ({ operator, left, right }) =>
    right === null
      ? `演算子${operator}は${left}を受け付けません。`
      : `演算子${operator}は${left}と${right}を受け付けません。`,
  "type.condition-not-bool": ({ statement }) => `${statement}の条件にはBOOLが必要です。`,
  "type.case-selector-not-integer": ({ type }) => `CASEの選択式には整数が必要ですが、${type}です。`,
  "type.case-label-not-integer": ({ type }) => `CASEラベルには整数が必要ですが、${type}です。`,
  "type.for-variable-not-integer": ({ name, type }) =>
    `FOR変数${name}には整数が必要ですが、${type}です。`,
  "type.for-bound-not-integer": ({ bound, type }) =>
    `FORの${jaBounds[bound]}には整数が必要ですが、${type}です。`,
  "flow.exit-outside-loop": () => "EXITはループ内で使用してください。",
  "fb.not-function-block": ({ name }) =>
    `${name}はファンクションブロックのインスタンスではありません。`,
  "fb.unknown-member": ({ name, member }) =>
    `不明なファンクションブロックのメンバーです: ${name}.${member}。`,
  "fb.output-not-writable": ({ name, member }) =>
    `ファンクションブロックの出力${name}.${member}には書き込めません。`,
  "fb.instance-as-value": ({ name }) =>
    `ファンクションブロックのインスタンス${name}はスカラー値として使用できません。`,
  "fb.unsupported-call": ({ name }) =>
    `ファンクションブロック${name}の入力は名前付きの:=で指定してください。位置引数と=>による出力指定には対応していません。`,
  "fb.call-in-expression": ({ name }) =>
    `ファンクションブロックの呼び出し${name}は式の中で使用できません。`,
  "call.unknown-function": ({ name }) => `不明な関数です: ${name}。`,
  "call.invalid-parameter": ({ name, parameter }) =>
    `${name}: パラメーター ${parameter} が不明、重複、または方向が正しくありません。`,
  "call.argument-count": ({ name, min, max, found }) =>
    max === null
      ? `${name}には${min}個以上の引数が必要ですが、${found}個です。`
      : `${name}には${min === max ? min : `${min}～${max}`}個の引数が必要ですが、${found}個です。`,
  "call.argument-type": ({ name, index, expected, found }) =>
    `${name}の${index + 1}番目の引数には${expected.join(" / ")}が必要ですが、${found}です。`,
  "runtime.invalid-value": () => "非有限の計算結果、またはREALのオーバーフローが発生しました。",
  "runtime.division-by-zero": () => "ゼロによる除算が発生しました。",
  "runtime.watchdog": ({ limit }) => `ループの反復回数の上限（${limit}回）を超えました。`,
  "runtime.for-by-zero": () => "FORの増分をゼロにすることはできません。",
  "runtime.debug-target": () =>
    "操作を拒否しました。読み込み済みプログラムのスカラー変数を選択してください。",
  "runtime.debug-type-mismatch": ({ from, to }) =>
    `操作を拒否しました。${to}型の変数に${from}型の値は書き込めません。`,
  "runtime.debug-value": () => "操作を拒否しました。値が無効か範囲外です。",
  "runtime.write-input-mapped": ({ name }) =>
    `操作を拒否しました。入力変数${name}には書き込めません。強制設定を使用してください。`,
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
  return template(diagnostic.args);
}
