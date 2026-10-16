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
`boolean`), with a numeric or boolean value. Decimal and base 2/8/16 integers
support underscores between digits. Reals support decimal points and signed
exponents. TIME/T durations have an optional sign after `#` and descending,
nonrepeated d/h/m/s/ms components, including fractional components; values are
milliseconds. Signs on ordinary numbers remain unary operators. Numeric values
are finite; integer literals and address components must be safe integers, and
duration magnitudes may not exceed `Number.MAX_SAFE_INTEGER`. Values outside
these representation limits produce the corresponding malformed-literal/address
diagnostic. REAL rounding, integer wrapping and TIME coercion belong to later
compilation stages.

The AST contains only plain, JSON-safe data. It does not enforce supported types,
I/O ranges, name resolution, writable FB members, constant initializers or operand
types. In particular, an address such as `%IX12.9` is syntactically valid and
remains available for a later `decl.address-out-of-range` diagnostic. FUNCTION,
FUNCTION_BLOCK, extended VAR forms, arrays, structs, strings and `=>` call outputs
are outside this parser's scope.
