// Configures @monaco-editor/react to use the bundled monaco-editor (not its CDN copy) and tells
// Monaco where its workers are. Imported by every component that renders an editor; browser-only.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "typescript" || label === "javascript") {
      return new Worker(new URL("./monaco/ts.worker.ts", import.meta.url), { type: "module" });
    }
    return new Worker(new URL("./monaco/editor.worker.ts", import.meta.url), { type: "module" });
  },
};
loader.config({ monaco });

export { monaco };
