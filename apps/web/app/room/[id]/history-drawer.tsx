"use client";

import type { Language } from "@codesync/shared";
import dynamic from "next/dynamic";
import { useState } from "react";

const ReadonlyCode = dynamic(() => import("@/components/readonly-code"), {
  ssr: false,
  loading: () => <div className="p-4 text-sm text-zinc-500">Loading preview…</div>,
});

interface VersionSummary {
  version: number;
  createdAt: string;
}

type ListState =
  { kind: "loading" } | { kind: "error" } | { kind: "ready"; versions: VersionSummary[] };

type PreviewState =
  | { kind: "none" }
  | { kind: "loading"; version: number }
  | { kind: "error"; version: number }
  | { kind: "ready"; version: number; createdAt: string; text: string };

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Lists the room's snapshots, previews one read-only, and lets the owner restore it.
 * Loads when opened (from the click handler, not an effect).
 */
export function useHistoryDrawer(roomId: string) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ListState>({ kind: "loading" });

  async function show() {
    setOpen(true);
    setList({ kind: "loading" });
    try {
      const res = await fetch(`/api/rooms/${roomId}/history`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const { versions } = (await res.json()) as { versions: VersionSummary[] };
      setList({ kind: "ready", versions });
    } catch {
      setList({ kind: "error" });
    }
  }

  return { open, list, show, hide: () => setOpen(false) };
}

export function HistoryDrawer({
  roomId,
  language,
  isOwner,
  list,
  onClose,
}: {
  roomId: string;
  language: Language;
  isOwner: boolean;
  list: ListState;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<PreviewState>({ kind: "none" });
  const [restoreState, setRestoreState] = useState<"idle" | "working" | "done" | "error">("idle");

  async function select(version: number) {
    setPreview({ kind: "loading", version });
    setRestoreState("idle");
    try {
      const res = await fetch(`/api/rooms/${roomId}/history/${version}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { version: number; createdAt: string; text: string };
      setPreview({ kind: "ready", ...data });
    } catch {
      setPreview({ kind: "error", version });
    }
  }

  async function restore(version: number) {
    if (
      !window.confirm(
        `Replace the current code with version ${version}? Everyone in the room will see the change.`,
      )
    ) {
      return;
    }
    setRestoreState("working");
    try {
      const res = await fetch(`/api/rooms/${roomId}/history/${version}/restore`, {
        method: "POST",
      });
      setRestoreState(res.ok ? "done" : "error");
    } catch {
      setRestoreState("error");
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        aria-label="History"
        data-testid="history-drawer"
        className="flex h-full w-full max-w-2xl flex-col bg-white shadow-xl dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="font-semibold">History</h2>
          <button type="button" onClick={onClose} className="text-sm text-zinc-500 hover:underline">
            Close
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav className="w-48 shrink-0 overflow-y-auto border-r border-zinc-200 dark:border-zinc-800">
            {list.kind === "loading" && <p className="p-3 text-sm text-zinc-500">Loading…</p>}
            {list.kind === "error" && (
              <p className="p-3 text-sm text-red-600">Couldn&apos;t load history.</p>
            )}
            {list.kind === "ready" && list.versions.length === 0 && (
              <p className="p-3 text-sm text-zinc-500">
                No saved versions yet. A version is saved when everyone leaves the room, and every
                200 edits.
              </p>
            )}
            {list.kind === "ready" && (
              <ul>
                {list.versions.map((v) => (
                  <li key={v.version}>
                    <button
                      type="button"
                      onClick={() => select(v.version)}
                      data-testid={`history-version-${v.version}`}
                      className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 ${
                        preview.kind !== "none" && preview.version === v.version
                          ? "bg-zinc-100 dark:bg-zinc-900"
                          : ""
                      }`}
                    >
                      <span className="block font-medium">Version {v.version}</span>
                      <span className="block text-xs text-zinc-500">
                        {dateFormat.format(new Date(v.createdAt))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          <section className="flex min-w-0 flex-1 flex-col">
            {preview.kind === "none" && (
              <p className="p-4 text-sm text-zinc-500">Pick a version to preview it.</p>
            )}
            {preview.kind === "loading" && <p className="p-4 text-sm text-zinc-500">Loading…</p>}
            {preview.kind === "error" && (
              <p className="p-4 text-sm text-red-600">Couldn&apos;t load this version.</p>
            )}
            {preview.kind === "ready" && (
              <>
                <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800">
                  <span>Version {preview.version} · read-only</span>
                  {isOwner ? (
                    <button
                      type="button"
                      onClick={() => restore(preview.version)}
                      disabled={restoreState === "working"}
                      className="ml-auto rounded-md bg-zinc-900 px-3 py-1 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      {restoreState === "working" ? "Restoring…" : "Restore this version"}
                    </button>
                  ) : (
                    <span className="ml-auto text-xs text-zinc-500">
                      Only the owner can restore
                    </span>
                  )}
                </div>
                {restoreState === "done" && (
                  <p role="status" className="px-4 py-2 text-sm text-emerald-600">
                    Restored. Everyone in the room now has version {preview.version}.
                  </p>
                )}
                {restoreState === "error" && (
                  <p role="alert" className="px-4 py-2 text-sm text-red-600">
                    Restore failed. Try again.
                  </p>
                )}
                <div className="min-h-0 flex-1" data-testid="history-preview">
                  <ReadonlyCode language={language} value={preview.text} />
                </div>
              </>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
