import {
  HighlightStyle,
  StreamLanguage,
  indentService,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { nextIndent, readStToken, type TokenizerState } from "./tokenizer.js";

const language = StreamLanguage.define<TokenizerState>({
  name: "Structured Text",
  startState: () => ({ commentDepth: 0 }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    const token = readStToken(stream.string.slice(stream.pos), state);
    stream.pos += token.length;
    return token.style;
  },
  languageData: { commentTokens: { line: "//", block: { open: "(*", close: "*)" } } },
});

export const stLanguage = [
  language,
  indentUnit.of("  "),
  indentService.of((context, pos) => {
    const current = context.lineAt(pos, 1);
    if (current.from === 0) return 0;
    const previous = context.lineAt(current.from - 1, -1);
    return nextIndent(previous.text, current.text, context.unit);
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: tags.keyword, class: "st-keyword" },
      { tag: tags.typeName, class: "st-type" },
      { tag: tags.className, class: "st-fb" },
      { tag: [tags.number, tags.bool], class: "st-literal" },
      { tag: tags.special(tags.variableName), class: "st-address" },
      { tag: tags.comment, class: "st-comment" },
    ]),
  ),
];
