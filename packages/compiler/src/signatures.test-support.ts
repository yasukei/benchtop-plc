/** ADR 0015 equivalence cases shared by override and interface signature tests. */
export const signatureTypes = [
  { name: "alias chain", left: "AliasInt", right: "INT", matches: true },
  { name: "named/anonymous subrange", left: "Percent", right: "INT (0..100)", matches: true },
  { name: "named subranges", left: "Percent", right: "OtherPercent", matches: true },
  { name: "string capacities", left: "STRING[10]", right: "STRING[20]", matches: true },
  { name: "wide string capacities", left: "WSTRING[10]", right: "WSTRING[20]", matches: true },
  { name: "structure alias", left: "PointAlias", right: "Point", matches: true },
  { name: "enumeration alias", left: "ColorAlias", right: "Color", matches: true },
  { name: "array alias", left: "TextArray", right: "ARRAY[1..2] OF STRING[20]", matches: true },
  { name: "reference alias target", left: "REF_TO AliasInt", right: "REF_TO INT", matches: true },
  { name: "subrange/base", left: "Percent", right: "INT", matches: false },
  { name: "different subrange bounds", left: "Percent", right: "INT (0..99)", matches: false },
  { name: "different subrange bases", left: "Percent", right: "DINT (0..100)", matches: false },
  { name: "distinct structures", left: "Point", right: "OtherPoint", matches: false },
  { name: "distinct enumerations", left: "Color", right: "OtherColor", matches: false },
  { name: "different string kinds", left: "STRING[10]", right: "WSTRING[10]", matches: false },
  {
    name: "different array bounds",
    left: "TextArray",
    right: "ARRAY[0..1] OF STRING[10]",
    matches: false,
  },
  { name: "reference subrange/base", left: "REF_TO Percent", right: "REF_TO INT", matches: false },
].flatMap((test) =>
  ["result", "VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT"].map((position) => ({ ...test, position })),
);

export const signatureTypeSources = [
  "TYPE IntBase : INT := 2; END_TYPE",
  "TYPE AliasInt : IntBase := 3; END_TYPE",
  "TYPE Percent : INT (0..100); END_TYPE",
  "TYPE OtherPercent : INT (0..100); END_TYPE",
  "TYPE Point : STRUCT x: INT; END_STRUCT; END_TYPE",
  "TYPE OtherPoint : STRUCT x: INT; END_STRUCT; END_TYPE",
  "TYPE PointAlias : Point; END_TYPE",
  "TYPE Color : (Red, Blue); END_TYPE",
  "TYPE OtherColor : (Red, Blue); END_TYPE",
  "TYPE ColorAlias : Color; END_TYPE",
  "TYPE TextArray : ARRAY[1..2] OF STRING[10]; END_TYPE",
];
