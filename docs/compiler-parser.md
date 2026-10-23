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
`address`, `eof` (matching token kinds), and `expression` (a grammatical construct).
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
`boolean`), with an approximate numeric or boolean value. Exact numeric checking
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
types. All elementary type keywords reserved by the lexer, including unsupported
types such as `WORD`, `SINT` and `STRING`, are accepted in type position and
retained for semantic analysis to report `decl.unknown-type`. They remain reserved
in identifier positions; string literals and extended string type syntax are
unsupported. In particular, an address such as `%IX12.9` is syntactically valid and
remains available for a later `decl.address-out-of-range` diagnostic. `parsePou` also accepts FUNCTION and FUNCTION_BLOCK, their input/output/temporary
sections and formal `=>` call outputs. Arrays, structs, strings and unsupported
extended VAR forms remain outside this parser's scope.

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
