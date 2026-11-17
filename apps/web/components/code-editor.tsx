"use client";

import type { Language } from "@codesync/shared";
import Editor from "@monaco-editor/react";
import { useEffect, useState } from "react";
import { MonacoBinding } from "y-monaco";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { monaco } from "./monaco-setup";
import { usePrefersDark } from "./use-prefers-dark";

export interface CodeEditorProps {
  language: Language;
  /** Shared document text; null until the collaboration session has started. */
  text: Y.Text | null;
  awareness: Awareness | null;
}

export default function CodeEditor({ language, text, awareness }: CodeEditorProps) {
  const dark = usePrefersDark();
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);

  // Bind Monaco to the shared Y.Text: local edits become CRDT updates and remote updates
  // (plus remote cursors and selections from awareness) are applied to the editor.
  useEffect(() => {
    const model = editor?.getModel();
    if (!editor || !model || !text) return;
    // Monaco defaults to the OS line ending (CRLF on Windows). Use LF everywhere so a shared
    // document never mixes line endings between collaborators on different platforms.
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    const binding = new MonacoBinding(text, model, new Set([editor]), awareness);
    return () => binding.destroy();
  }, [editor, text, awareness]);

  return (
    <Editor
      height="100%"
      language={language}
      theme={dark ? "vs-dark" : "light"}
      onMount={(mounted) => setEditor(mounted)}
      options={{
        automaticLayout: true,
        fontSize: 14,
        minimap: { enabled: false },
        readOnly: !text,
        scrollBeyondLastLine: false,
        tabSize: language === "python" ? 4 : 2,
      }}
    />
  );
}
