import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import type { ChangeSet } from "@codemirror/state";
import type { SourceSpan } from "@benchtop-plc/core";
import { createStEditor, type EditorProps, type StEditorController } from "./controller.js";

export interface StEditorHandle {
  focusSpan(span: SourceSpan): void;
}

export function StEditor(
  props: EditorProps & {
    onChange: (source: string, changes?: ChangeSet) => void;
    ref?: Ref<StEditorHandle>;
  },
) {
  const parent = useRef<HTMLDivElement>(null);
  const controller = useRef<StEditorController | null>(null);
  const initial = useRef(props);
  useLayoutEffect(() => {
    const editor = createStEditor(
      parent.current!,
      initial.current.source,
      initial.current.onChange,
    );
    controller.current = editor;
    return () => {
      editor.destroy();
      controller.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    controller.current?.update(props);
  });
  useImperativeHandle(
    props.ref,
    () => ({ focusSpan: (span) => controller.current?.focusSpan(span) }),
    [],
  );
  return <div className="st-editor" ref={parent} />;
}
