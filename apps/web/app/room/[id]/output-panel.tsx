"use client";

import { RUN_LIMITS, type RunResult } from "@codesync/shared";
import { useState } from "react";

export type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: RunResult }
  | { kind: "error"; message: string };

const ERROR_MESSAGES: Record<string, string> = {
  rate_limited: "You're running code too often. Wait a few seconds and try again.",
  busy: "The sandbox is busy. Try again in a moment.",
  warming_up: "The sandbox is starting up. Try again in a moment.",
  code_too_large: `Code is over ${RUN_LIMITS.codeBytes / 1024} KB, the most the sandbox accepts.`,
  stdin_too_large: `Input is over ${RUN_LIMITS.stdinBytes / 1024} KB, the most the sandbox accepts.`,
  runner_unreachable: "The sandbox is unreachable right now.",
};

/** Posts the current code to /api/run and tracks the result. */
export function useRunner(roomId: string) {
  const [state, setState] = useState<RunState>({ kind: "idle" });
  const [stdin, setStdin] = useState("");

  async function run(code: string) {
    if (state.kind === "running") return;
    setState({ kind: "running" });
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId, code, stdin }),
      });
      const data = (await res.json().catch(() => ({}))) as RunResult & { error?: string };
      if (!res.ok) {
        setState({
          kind: "error",
          message: (data.error && ERROR_MESSAGES[data.error]) ?? "The run failed. Try again.",
        });
        return;
      }
      setState({ kind: "done", result: data });
    } catch {
      setState({ kind: "error", message: "Network error. Check your connection." });
    }
  }

  return { state, run, stdin, setStdin };
}

export function OutputPanel({
  state,
  stdin,
  onStdinChange,
}: {
  state: RunState;
  stdin: string;
  onStdinChange: (value: string) => void;
}) {
  const [tab, setTab] = useState<"output" | "input">("output");

  return (
    <section
      aria-label="Run output"
      data-testid="output-panel"
      className="flex h-56 shrink-0 flex-col border-t border-zinc-200 dark:border-zinc-800"
    >
      <div className="flex items-center gap-1 border-b border-zinc-200 px-2 text-sm dark:border-zinc-800">
        {(["output", "input"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={`px-2 py-1.5 ${
              tab === t
                ? "border-b-2 border-zinc-900 font-medium dark:border-zinc-100"
                : "text-zinc-500"
            }`}
          >
            {t === "output" ? "Output" : "Input (stdin)"}
          </button>
        ))}
        {state.kind === "done" && <ResultBadges result={state.result} />}
      </div>

      {tab === "input" ? (
        <textarea
          value={stdin}
          onChange={(e) => onStdinChange(e.target.value)}
          placeholder="Text your program reads from standard input"
          aria-label="Standard input"
          className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-sm outline-none"
        />
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto p-3 font-mono text-sm"
          data-testid="run-output"
        >
          {state.kind === "idle" && (
            <p className="text-zinc-500">Press Run (Ctrl/⌘ + Enter) to execute the code.</p>
          )}
          {state.kind === "running" && <p className="text-zinc-500">Running…</p>}
          {state.kind === "error" && (
            <p role="alert" className="text-red-600 dark:text-red-400">
              {state.message}
            </p>
          )}
          {state.kind === "done" && (
            <>
              <pre className="whitespace-pre-wrap" data-testid="run-stdout">
                {state.result.stdout}
              </pre>
              {state.result.stderr && (
                <pre
                  className="whitespace-pre-wrap text-red-600 dark:text-red-400"
                  data-testid="run-stderr"
                >
                  {state.result.stderr}
                </pre>
              )}
              {!state.result.stdout && !state.result.stderr && (
                <p className="text-zinc-500">(no output)</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ResultBadges({ result }: { result: RunResult }) {
  const ok = result.exit_code === 0 && !result.timed_out;
  return (
    <div className="ml-auto flex items-center gap-2 text-xs" data-testid="run-meta">
      {result.timed_out && <Badge tone="red">Timed out (5 s)</Badge>}
      {result.oom_killed && <Badge tone="red">Out of memory (128 MB)</Badge>}
      {result.output_truncated && <Badge tone="amber">Output cut at 64 KB</Badge>}
      <Badge tone={ok ? "green" : "red"}>exit {result.exit_code ?? "?"}</Badge>
      <span className="text-zinc-500">{result.duration_ms} ms</span>
    </div>
  );
}

function Badge({ tone, children }: { tone: "green" | "red" | "amber"; children: React.ReactNode }) {
  const colors = {
    green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
    red: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
    amber: "bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200",
  }[tone];
  return <span className={`rounded px-1.5 py-0.5 font-medium ${colors}`}>{children}</span>;
}
