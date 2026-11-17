"use client";

import type { Language } from "@codesync/shared";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { LanguageBadge } from "@/components/language-badge";

// Monaco touches window at import time, so it only ever loads in the browser.
const CodeEditor = dynamic(() => import("@/components/code-editor"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-zinc-500">
      Loading editor…
    </div>
  ),
});

export interface RoomViewProps {
  room: { id: string; name: string; language: Language; isOwner: boolean };
  user: { name: string; image: string | null };
}

export function RoomView({ room, user }: RoomViewProps) {
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          CodeSync
        </Link>
        <span className="text-zinc-300 dark:text-zinc-700">/</span>
        <h1 className="truncate text-sm font-medium" data-testid="room-name">
          {room.name}
        </h1>
        <LanguageBadge language={room.language} />
        <div className="ml-auto flex items-center gap-3">
          <ShareButton />
          <span className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            {user.image ? (
              // eslint-disable-next-line @next/next/no-img-element -- remote GitHub avatars
              <img src={user.image} alt="" className="size-6 rounded-full" />
            ) : null}
            {user.name}
          </span>
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <CodeEditor language={room.language} />
      </main>
    </div>
  );
}

function ShareButton() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link to share the room:", window.location.href);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
    >
      {copied ? "Link copied" : "Share link"}
    </button>
  );
}
