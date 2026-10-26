import type { Diagnostic, ConfigurationIR, RuntimeSnapshot, SourceSpan } from "@benchtop-plc/core";
import { defaultKeymap, history, historyKeymap, indentLess } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type ChangeSet,
} from "@codemirror/state";
import {
  Decoration,
  GutterMarker,
  gutter,
  EditorView,
  WidgetType,
  drawSelection,
  hoverTooltip,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { catalogs, type Language } from "../catalog.js";
import { formatDiagnostic } from "../diagnostic-catalog.js";
import { insertSpacesOrIndent } from "./commands.js";
import { stLanguage } from "./language.js";
import { createDataTypes } from "../pous.js";
import { blockTypeAt } from "./block-hover.js";
import { mapAnnotations, spanRange, type InlineAnnotation } from "./mapping.js";

export interface EditorProps {
  source: string;
  diagnostics: Diagnostic[];
  snapshot: RuntimeSnapshot | null;
  online: boolean;
  fault: Diagnostic | null;
  language: Language;
  ir?: ConfigurationIR;
  sources?: readonly string[];
  dataTypes?: readonly string[];
  sourceIndex?: number;
  pou?: string;
  instance?: string;
  breakpointLines?: { line: number; active: boolean }[];
  onToggleBreakpoint?: (line: number) => void;
  haltSpan?: SourceSpan;
}

class BreakpointMarker extends GutterMarker {
  constructor(
    private readonly line: number,
    private readonly active: boolean | undefined,
    private readonly label: string,
  ) {
    super();
  }
  override eq(other: BreakpointMarker): boolean {
    return this.line === other.line && this.active === other.active && this.label === other.label;
  }
  override toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "breakpoint-marker";
    marker.dataset.line = String(this.line);
    marker.dataset.breakpoint =
      this.active === undefined ? "none" : this.active ? "active" : "inactive";
    marker.setAttribute("aria-label", this.label.replace("{line}", String(this.line)));
    marker.title = marker.getAttribute("aria-label")!;
    marker.textContent = this.active === undefined ? " " : this.active ? "●" : "○";
    return marker;
  }
}

class ValuesWidget extends WidgetType {
  constructor(
    private readonly annotation: InlineAnnotation,
    private readonly staleLabel?: string,
  ) {
    super();
  }
  override eq(other: ValuesWidget): boolean {
    return (
      JSON.stringify(this.annotation) === JSON.stringify(other.annotation) &&
      this.staleLabel === other.staleLabel
    );
  }
  toDOM(): HTMLElement {
    const container = document.createElement("span");
    container.className = "inline-values";
    container.dataset.line = String(this.annotation.line);
    for (const value of this.annotation.values) {
      const badge = document.createElement("span");
      badge.textContent = value.text;
      badge.className = value.dataType === "BOOL" ? "inline-bool" : "inline-number";
      badge.dataset.type = value.dataType;
      badge.title = value.dataType;
      container.append(badge);
    }
    if (this.staleLabel) {
      const stale = document.createElement("span");
      stale.className = "inline-stale";
      stale.textContent = this.staleLabel;
      container.append(stale);
    }
    return container;
  }
}

const displayEffect = StateEffect.define<DecorationSet>();
const displayField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(displayEffect)) return effect.value;
    return transaction.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** All CodeMirror plumbing lives outside the React lifecycle wrapper. */
export function createStEditor(
  parent: HTMLElement,
  source: string,
  onChange: (source: string, changes?: ChangeSet) => void,
) {
  const accessibility = new Compartment();
  const highlighting = new Compartment();
  let previous: EditorProps | undefined;
  let displayProps: EditorProps | undefined;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: source,
      extensions: [
        highlighting.of(stLanguage()),
        history(),
        gutter({
          class: "cm-breakpoints",
          lineMarker(view, line) {
            if (!displayProps?.onToggleBreakpoint) return null;
            const number = view.state.doc.lineAt(line.from).number;
            return new BreakpointMarker(
              number,
              displayProps.breakpointLines?.find((marker) => marker.line === number)?.active,
              catalogs[displayProps.language].toggleBreakpoint,
            );
          },
          lineMarkerChange: (update) =>
            update.transactions.some((transaction) =>
              transaction.effects.some((effect) => effect.is(displayEffect)),
            ),
          domEventHandlers: {
            mousedown(view, line, event) {
              if (!displayProps?.onToggleBreakpoint || (event as MouseEvent).button !== 0)
                return false;
              displayProps.onToggleBreakpoint(view.state.doc.lineAt(line.from).number);
              event.preventDefault();
              return true;
            },
          },
        }),
        lineNumbers(),
        drawSelection(),
        bracketMatching(),
        keymap.of([
          { key: "Tab", run: insertSpacesOrIndent },
          { key: "Shift-Tab", run: indentLess },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        displayField,
        hoverTooltip((_view, position) => {
          if (!previous) return null;
          const hover = blockTypeAt(
            previous.sources ?? [previous.source],
            previous.sourceIndex ?? 0,
            position,
            previous.dataTypes,
          );
          return hover
            ? {
                pos: hover.from,
                end: hover.to,
                create() {
                  const dom = document.createElement("div");
                  dom.textContent = hover.text;
                  return { dom };
                },
              }
            : null;
        }),
        accessibility.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString(), update.changes);
        }),
        EditorView.theme({
          "&": { backgroundColor: "var(--surface)", color: "var(--text)" },
          ".cm-scroller": {
            overflow: "auto",
            fontFamily: "ui-monospace, monospace",
            lineHeight: "1.85",
          },
          ".cm-content": { caretColor: "var(--text)", minHeight: "320px" },
          ".cm-gutters": {
            backgroundColor: "var(--background)",
            color: "var(--muted)",
            borderColor: "var(--border)",
          },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            backgroundColor: "var(--selection)",
          },
          ".cm-cursor": { borderLeftColor: "var(--text)" },
          ".cm-tooltip": {
            backgroundColor: "var(--surface)",
            color: "var(--text)",
            borderColor: "var(--border)",
          },
        }),
      ],
    }),
  });
  return {
    update(props: EditorProps) {
      displayProps = props;
      if (view.state.doc.toString() !== props.source) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.source } });
      }
      const decorations = mapAnnotations(
        props.source,
        props.snapshot,
        props.online,
        props.ir,
        props.pou,
        props.instance,
      ).map((annotation) =>
        Decoration.widget({
          widget: new ValuesWidget(
            annotation,
            annotation.fromScan === undefined
              ? undefined
              : catalogs[props.language].inlineFromScan.replace(
                  "{scan}",
                  String(annotation.fromScan),
                ),
          ),
          side: 1,
        }).range(annotation.position),
      );
      if (props.online && props.fault?.span) {
        const position = spanRange(props.source, props.fault.span).from;
        decorations.push(
          Decoration.line({ class: "runtime-fault-line" }).range(
            view.state.doc.lineAt(position).from,
          ),
        );
      }
      if (props.online && props.haltSpan) {
        const range = spanRange(props.source, props.haltSpan);
        decorations.push(
          Decoration.line({ class: "runtime-halt-line" }).range(
            view.state.doc.lineAt(range.from).from,
          ),
        );
        if (range.to > range.from)
          decorations.push(
            Decoration.mark({ class: "runtime-halt-statement" }).range(range.from, range.to),
          );
      }
      const effects: StateEffect<unknown>[] = [displayEffect.of(Decoration.set(decorations, true))];
      if (JSON.stringify(previous?.dataTypes) !== JSON.stringify(props.dataTypes)) {
        effects.push(
          highlighting.reconfigure(
            stLanguage(createDataTypes(props.dataTypes ?? []).map((type) => type.name)),
          ),
        );
      }
      if (previous?.language !== props.language) {
        const text = catalogs[props.language];
        effects.push(
          accessibility.reconfigure([
            EditorView.contentAttributes.of({ "aria-label": text.editor }),
            EditorState.phrases.of({
              Diagnostics: text.diagnostics,
              "No diagnostics": text.noDiagnostics,
              close: text.close,
              "Control character": text.controlCharacter,
            }),
          ]),
        );
      }
      view.dispatch({ effects });
      if (
        previous?.source !== props.source ||
        previous?.language !== props.language ||
        previous?.diagnostics !== props.diagnostics
      ) {
        view.dispatch(
          setDiagnostics(
            view.state,
            props.diagnostics.map((diagnostic) => ({
              ...(diagnostic.span ? spanRange(props.source, diagnostic.span) : { from: 0, to: 0 }),
              source: diagnostic.pou,
              severity: diagnostic.severity,
              message: formatDiagnostic(props.language, diagnostic),
            })),
          ),
        );
      }
      previous = props;
    },
    focusSpan(span: SourceSpan) {
      const range = spanRange(view.state.doc.toString(), span);
      view.dispatch({ selection: { anchor: range.from, head: range.to }, scrollIntoView: true });
      view.focus();
    },
    destroy: () => view.destroy(),
  };
}
export type StEditorController = ReturnType<typeof createStEditor>;
