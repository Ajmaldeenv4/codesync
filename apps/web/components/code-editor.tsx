"use client";

import type { Language } from "@codesync/shared";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useEffect, useState, useSyncExternalStore } from "react";
import { MonacoBinding } from "y-monaco";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

// Use the bundled monaco-editor rather than the CDN copy @monaco-editor/react loads by default:
// y-monaco imports monaco-editor directly, so both must be the same instance.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new Worker(new URL("./monaco/ts.worker.ts", import.meta.url), { type: "module" });
    }
    return new Worker(new URL("./monaco/editor.worker.ts", import.meta.url), { type: "module" });
  },
};
loader.config({ monaco });

const darkQuery = "(prefers-color-scheme: dark)";

function subscribeToColorScheme(onChange: () => void) {
  const media = window.matchMedia(darkQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function usePrefersDark() {
  return useSyncExternalStore(
    subscribeToColorScheme,
    () => window.matchMedia(darkQuery).matches,
    () => false,
  );
}

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
