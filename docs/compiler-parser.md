# Structured Text lexer and parser

`@benchtop-plc/compiler` exports `lex(source)` and `parse(source)`. Both are pure,
host-independent functions. `lex` returns `{ tokens, diagnostics }`; `parse`
returns `{ ast, diagnostics }`. Success has an empty diagnostic array. Failure
has a null payload and one diagnostic from the shared core catalog, including a
source span and typed arguments. The parser tokenizes the whole input first, so
a lexical failure takes precedence over syntax diagnostics. There is no error
recovery or partial AST.

```ts
import { parse } from "@benchtop-plc/compiler";

const result = parse("PROGRAM Main VAR count : INT; END_VAR count := 1; END_PROGRAM");
if (result.ast) {
  // Names and type names remain unresolved until semantic analysis.
  const programName = result.ast.name.name;
}
```

## Source and names

Tokens keep exact source `text` and an upper-case `key`. Identifiers in the AST
keep original `name`, upper-case `key` and a span. Keywords and names are
case-insensitive. Positions are one-based UTF-16 line/column coordinates, with
exclusive ends; LF, CRLF and CR each count as one line break. Tabs count as one
column. EOF has an empty span. Whitespace, line comments and arbitrarily nested
`(* ... *)` comments are discarded while still updating positions.

All AST nodes have spans, including declaration names, type names, addresses,
conditional and CASE branches, labels and named FB inputs. Statement spans include
their terminating semicolon; program spans end after `END_PROGRAM` (an optional
trailing semicolon is accepted). Parentheses produce a `group` node so the inner
expression retains its exact span. Missing terminators have an empty insertion
span; other syntax errors point at the offending token. EOF diagnostics follow
the selection rules in [diagnostics.md](diagnostics.md).

For localization, `syntax.expected-token.args.expected` uses a literal spelling
(such as `;` or `END_REPEAT`) or one of these stable identifiers: `identifier`,
`address`, `integer`, `eof` (matching token kinds), and `expression` (a grammatical construct).
`args.found` is the actual token's source spelling. A stray token after an UNTIL
condition reports `syntax.expected-token`; EOF or an enclosing `END_*` in that
position reports `syntax.missing-end` for `END_REPEAT`.

## Syntax and values

One textual `PROGRAM` is accepted, with zero or more `VAR` blocks followed by its
statements. Declarations retain grouped names, optional `AT` addresses, type names
and optional initializer expressions. Statements cover assignment, named FB calls,
IF/ELSIF/ELSE, CASE/ELSE with label lists and ranges, FOR with optional BY, WHILE,
REPEAT/UNTIL, EXIT and RETURN. CASE labels remain expressions for later constant
and integer checks. An omitted BY stays absent in the AST. Empty statement lists
and empty statements are accepted.

Expressions support literals, name/member references, positional function calls,
parentheses and these operators (highest precedence first):

1. Unary `+`, `-`, `NOT`
2. `*`, `/`, `MOD`
3. `+`, `-`
4. `<`, `>`, `<=`, `>=`
5. `=`, `<>`
6. `AND`, `&` (both stored as `AND`)
7. `XOR`
8. `OR`

Binary operators associate left; unary operators nest right. Calls bind more
tightly than unary operators. Function and FB names are not resolved here.

Literal nodes retain original text and a lexical kind (`integer`, `real`, `time`,
`boolean`, `calendar`, `string`), with a decoded string, approximate numeric or boolean value. Exact numeric checking
uses the source text, so lexical numeric magnitudes are unbounded; a non-finite
approximation is stored as zero to keep AST data JSON-safe. Decimal and base 2/16
integers support underscores between digits. Octal `8#` is rejected. Reals support
decimal points and signed exponents. BOOL/INT/DINT/UINT/REAL/LREAL typed literals
are single tokens with a `dataType`, including `INT#-5` and `UINT#16#FF`.
TIME/T durations have an optional sign after `#` and descending, nonrepeated
d/h/m/s/ms components, optionally separated by a single underscore. Only the final
component may be fractional; values are milliseconds. Signs on untyped numbers
remain unary operators. Address components must be safe integers; values outside
that limit produce `lex.malformed-direct-address`. Duration magnitudes are
unbounded lexically; the checker validates the TIME range from the exact source
text and reports `type.invalid-constant` for out-of-range durations. Exact constant
arithmetic, range checks and binary32/64 rounding belong to semantic checking.

The AST contains only plain, JSON-safe data. It does not enforce supported types,
I/O ranges, name resolution, writable FB members, constant initializers or operand
types. Elementary type keywords are accepted in type position and remain reserved
in identifier positions. Declarations, aliases and function results accept
`STRING[n]` and `WSTRING[n]`, where n is an integer literal. The AST keeps the
optional capacity in `stringLength` or `resultStringLength`; the checker enforces
1–1,024 and supplies the default 80. `CHAR` and `WCHAR` have no capacity suffix. In particular, an address such as `%IX12.9` is syntactically valid and
remains available for a later `decl.address-out-of-range` diagnostic. `parsePou` also accepts FUNCTION and FUNCTION_BLOCK, their input/output/temporary
sections and formal `=>` call outputs. Unsupported extended VAR forms remain
outside this parser's scope.

## Data type declarations and derived scalar syntax

`parseDataType(source)` parses exactly one `TYPE Name : definition; END_TYPE`
source and reports lexical/syntax errors with that source name in `pou`.
A definition can be an alias with an optional initializer, `(Red, Green, Blue)`,
`INT (Off := 0, Auto := 10)`, or `INT (-10..10)`. Members keep their spelling,
spans and optional value expressions; subranges retain their bound expressions.
The parser distinguishes enumeration lists from range bounds; semantic checks
validate integer bases, constant bounds, distinct member names and values.

POU declarations and function result types accept inline subranges. A qualified
literal such as `Color#Red` is an `enumeration` AST expression with separate type
and member identifiers. Unqualified values remain ordinary `name` nodes until
contextual resolution. The lexer recognizes the separating `#` without changing
existing elementary typed numeric, duration or calendar literal tokens.

## Character literals

Single-quoted literals hold single-byte text; double-quoted literals hold UTF-16
code units. Each is one `string` token, including its optional `STRING#`,
`WSTRING#`, `CHAR#` or `WCHAR#` prefix. Comment delimiters inside a literal are text.
The lexer decodes `$$`, an escaped matching quote, `$L`, `$N`, `$P`, `$R`, `$T`
(case-insensitive), and hexadecimal `$hh` or `$hhhh`, respectively. Opposite
quotes need no escape. Missing terminators or physical line breaks report
`lex.unterminated-string`; unknown or incomplete escapes report
`lex.invalid-string-escape`; a single-byte code unit above 16#FF reports
`lex.invalid-string-character`. Character counts and typed delimiter matching
are checked semantically.

## Array syntax

Declarations and data type sources accept `ARRAY[l..u, ...] OF T`, including nested
array element declarations. The AST retains bound expressions and element type
syntax in `ArrayDeclaration`. An `index` node retains one array reference and its
ordered index expressions; repeated brackets form a chain (`n[i][j]`). Indexed
bit selectors (`flags[i].3`) use `elementBit`. These references are assignment
targets and expressions, including in FOR bounds and call arguments.

Declaration initializers accept lists (`[1, 2, 3(0)]`), repeated groups
(`[2(1, 2)]`) and nested lists. `arrayInitializer` retains repetitions without
expanding them during parsing. Lists are not body expressions.

## Structure syntax

`parseDataType` accepts `TYPE Point : STRUCT x : REAL; y : REAL := 1.0;
END_STRUCT; END_TYPE`. The AST retains ordered member declarations and defaults.
Declaration initializers accept `(x := 1.0, y := 2.0)` and `()` for all defaults;
`structureInitializer` retains named values and nests inside array or structure
initializers. Initializers remain declaration-only syntax.

A first dotted selector is a `member` node, keeping existing FB/bit syntax.
Subsequent selectors are `field` nodes with an object reference; `index` bases may
be any reference. This permits `line[2].start.x` and `recipe.steps[i].duration`.
The checker distinguishes structure members from scalar bit selectors (`w.3` or
`w.CONSTANT`); the parser retains the selector spelling in either case.

## Reference syntax

`REF_TO T` is accepted in declarations, aliases, structure members, array elements,
POU parameters and function results. Its recursive `TypeSyntax` retains the target
name, array bounds, string capacity or subrange, including source spans. `REF(x)`
is parsed as a reserved call and `NULL` as its own expression. Postfix `^` creates
a `dereference` node and composes with member/index selectors, for example
`r^.x`, `r^[i]` and `rr^^.x`. `REF_TO`, `REF` and `NULL` are reserved identifiers.

## Configuration source parser

`parseConfiguration(source)` returns `{ ast?, diagnostics }` independently of the
POU and data type parsers. It uses the same lexer and source spans:

```st
CONFIGURATION Plant
RESOURCE Station ON SomeCpu
  TASK T (INTERVAL := T#10ms, PRIORITY := 1);
  PROGRAM A WITH T : Counter;
  PROGRAM B WITH T : Counter;
END_RESOURCE
END_CONFIGURATION
```

The AST retains configuration/resource/task/instance/type identifiers and task
bindings. `ON` consumes any identifier and discards it. The current subset supports
one resource, up to 16 tasks and `WITH` on every instance. Each task requires either
`INTERVAL` or `SINGLE`, together with `PRIORITY`. Duplicate or unsupported task
parameters are diagnostics, as are a second resource or configuration. Task
parameter names are contextual: `INTERVAL`, `SINGLE` and `PRIORITY` remain ordinary
identifier tokens. `INTERVAL` and `PRIORITY` values must be literals; the parser
checks their exact numeric limits. `SINGLE` retains its address or global-name
tokens for project checking, which resolves event inputs, task/type names and
namespace collisions. The parser also accepts `VAR_GLOBAL` sections in the
configuration and resource, and program parameter connections (`:=` inputs and
`=>` outputs).

## Method syntax

`METHOD [PUBLIC | PROTECTED | PRIVATE | INTERNAL] name [: type] ... END_METHOD`
appears inside `FUNCTION_BLOCK`, after its variable sections and before its body.
A method allows `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT` and `VAR CONSTANT`/`VAR`.
Calls parse as `instance.M(...)`, `instances[i].M(...)`, `M(...)` or `THIS.M(...)`;
`THIS.member` accesses an instance member, including calls to member function block
instances (`THIS.timer(...)`) and their array elements (`THIS.items[i](...)`).
Access precedes all other qualifiers on
function block `VAR` sections. Duplicate access qualifiers and access on other
sections are errors. These seven new keywords are reserved: `METHOD`, `END_METHOD`,
`THIS`, `PUBLIC`, `PROTECTED`, `PRIVATE`, `INTERNAL`.

The optional `legacyNames` parser/lexer argument is used only to validate syntax
when importing older project files. Compilation and editor parsing always use the
current reserved words. Import does not make such source executable.

## Class syntax

`parsePou` accepts `CLASS Name` followed by variable sections, methods and
`END_CLASS`, with an optional closing semicolon. Its AST has `kind: "class"` and
an empty `body`. Statements outside methods report `class.body`. Section legality
is checked semantically, including empty forbidden sections. VAR access specifiers
use the method/block grammar and precede CONSTANT, RETAIN or NON_RETAIN.
CLASS and END_CLASS are reserved; both also join `newlyReservedWords`, so the
legacy project-opening parser can recover older identifier uses as drafts.

## Inheritance headers and SUPER

Headers use `CLASS [ABSTRACT | FINAL] Name [EXTENDS Base]` or
`FUNCTION_BLOCK [ABSTRACT | FINAL] Name [EXTENDS Base]`. Methods use
`METHOD [access] [ABSTRACT | FINAL] [OVERRIDE] Name [: type]` in that order.
Conflicting or repeated abstract/final modifiers are rejected; semantic checking
validates bases, abstract bodies and override compatibility. `EXTENDS`, `OVERRIDE`,
`SUPER`, `ABSTRACT` and `FINAL` are reserved, with the existing legacy-name import
path for 0.6.0 files. `SUPER.M(...)` parses as a method receiver and `SUPER();` as a
body call; the checker restricts their contexts and targets.
