"use client";

import type { Language } from "@codesync/shared";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useSyncExternalStore } from "react";

// Use the bundled monaco-editor rather than the CDN copy @monaco-editor/react loads by default.
// y-monaco (Phase 2) imports monaco-editor directly, so both must be the same instance.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new Worker(new URL("./monaco/ts.worker.ts", import.meta.url), { type: "module" });
    }
    return new Worker(new URL("./monaco/editor.worker.ts", import.meta.url), { type: "module" });
  },
};
loader.config({ monaco });

const STARTER_CODE: Record<Language, string> = {
  javascript: '// JavaScript\nconsole.log("Hello from CodeSync");\n',
  python: '# Python\nprint("Hello from CodeSync")\n',
};

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

export default function CodeEditor({ language }: { language: Language }) {
  const dark = usePrefersDark();
  return (
    <Editor
      height="100%"
      language={language}
      defaultValue={STARTER_CODE[language]}
      theme={dark ? "vs-dark" : "light"}
      options={{
        automaticLayout: true,
        fontSize: 14,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: language === "python" ? 4 : 2,
      }}
    />
  );
}
