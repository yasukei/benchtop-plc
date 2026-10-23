import { characterTypes } from "@benchtop-plc/core";
import { scalarTypes } from "./type-rules.js";

/** ADR 0015 reserves the namespace before later issues add these implementations. */
const reservedStandardNames = new Set([
  "LEN",
  "LEFT",
  "RIGHT",
  "MID",
  "CONCAT",
  "INSERT",
  "DELETE",
  "REPLACE",
  "FIND",
  "LOWER_BOUND",
  "UPPER_BOUND",
  "TO_STRING",
  "TO_WSTRING",
  "STRING_TO_WSTRING",
  "WSTRING_TO_STRING",
  "CHAR_TO_STRING",
  "WCHAR_TO_WSTRING",
  "STRING_TO_CHAR",
  "WSTRING_TO_WCHAR",
  "CHAR_TO_WCHAR",
  "WCHAR_TO_CHAR",
  "CHAR_TO_BYTE",
  "BYTE_TO_CHAR",
  "WCHAR_TO_WORD",
  "WORD_TO_WCHAR",
  ...scalarTypes
    .filter((type) => !characterTypes.some((character) => character === type))
    .flatMap((type) => [
      `${type}_TO_STRING`,
      `${type}_TO_WSTRING`,
      `STRING_TO_${type}`,
      `WSTRING_TO_${type}`,
    ]),
]);

export const isReservedStandardName = (name: string): boolean => reservedStandardNames.has(name);
