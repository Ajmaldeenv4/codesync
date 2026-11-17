"use client";

import type { Language } from "@codesync/shared";
import Editor from "@monaco-editor/react";
import "./monaco-setup";
import { usePrefersDark } from "./use-prefers-dark";

/** A read-only Monaco view of some code (history previews). */
export default function ReadonlyCode({ language, value }: { language: Language; value: string }) {
  const dark = usePrefersDark();
  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      theme={dark ? "vs-dark" : "light"}
      options={{
        automaticLayout: true,
        domReadOnly: true,
        fontSize: 13,
        minimap: { enabled: false },
        readOnly: true,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
