"use client";

import type { Language } from "@codesync/shared";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { LanguageBadge } from "@/components/language-badge";
import { CollabSession, type ConnectionStatus } from "@/lib/collab-session";
import {
  colorForUser,
  remoteCursorCss,
  type PresenceUser,
  type RemotePresence,
} from "@/lib/presence";
import type { RoomMemberSummary } from "@/lib/rooms";
import { ChatPanel } from "./chat-panel";
import { HistoryDrawer, useHistoryDrawer } from "./history-drawer";
import { OutputPanel, useRunner } from "./output-panel";

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
  user: { id: string; name: string; image: string | null };
  members: RoomMemberSummary[];
  collabUrl: string;
}

export function RoomView({ room, user, members, collabUrl }: RoomViewProps) {
  const [session] = useState(() => new CollabSession({ roomId: room.id, collabUrl, user }));
  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  const [chatOpen, setChatOpen] = useState(true);
  const history = useHistoryDrawer(room.id);
  const runner = useRunner(room.id);
  const running = runner.state.kind === "running";

  const runCode = () => {
    if (snapshot.text) void runner.run(snapshot.text.toString());
  };
  // Ctrl/⌘+Enter runs the code. Capture phase, so Monaco's own Ctrl+Enter binding doesn't fire.
  const onRunShortcut = useEffectEvent(runCode);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        onRunShortcut();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const cursorCss =
    snapshot.localClientId === null
      ? ""
      : remoteCursorCss(snapshot.presence, snapshot.localClientId);

  return (
    <div className="flex h-dvh flex-col">
      <style>{cursorCss}</style>
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
          <StatusPill status={snapshot.status} />
          <button
            type="button"
            onClick={runCode}
            disabled={running || !snapshot.text}
            title="Run (Ctrl/⌘ + Enter)"
            className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
          >
            {running ? "Running…" : "Run ▶"}
          </button>
          <HeaderButton onClick={history.show}>History</HeaderButton>
          <HeaderButton onClick={() => setChatOpen((v) => !v)} pressed={chatOpen}>
            Chat{!chatOpen && snapshot.chat.length > 0 ? ` (${snapshot.chat.length})` : ""}
          </HeaderButton>
          <ShareButton />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <CodeEditor
              language={room.language}
              text={snapshot.text}
              awareness={snapshot.awareness}
            />
          </div>
          <OutputPanel state={runner.state} stdin={runner.stdin} onStdinChange={runner.setStdin} />
        </main>
        <aside className="hidden w-72 shrink-0 flex-col border-l border-zinc-200 md:flex dark:border-zinc-800">
          <MemberList
            members={members}
            presence={snapshot.presence}
            seenUsers={snapshot.seenUsers}
            selfId={user.id}
          />
          {chatOpen && (
            <ChatPanel
              messages={snapshot.chat}
              selfId={user.id}
              onSend={(text) => session.sendChat(text)}
              disabled={snapshot.text === null}
            />
          )}
        </aside>
      </div>
      {history.open && (
        <HistoryDrawer
          roomId={room.id}
          language={room.language}
          isOwner={room.isOwner}
          list={history.list}
          onClose={history.hide}
        />
      )}
    </div>
  );
}

function HeaderButton({
  onClick,
  pressed,
  children,
}: {
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900 ${
        pressed ? "bg-zinc-100 dark:bg-zinc-900" : ""
      }`}
    >
      {children}
    </button>
  );
}

const STATUS_STYLES: Record<ConnectionStatus, { label: string; dot: string }> = {
  connected: { label: "Connected", dot: "bg-emerald-500" },
  connecting: { label: "Connecting…", dot: "bg-amber-500 animate-pulse" },
  reconnecting: { label: "Reconnecting…", dot: "bg-amber-500 animate-pulse" },
  offline: { label: "Offline: edits will sync later", dot: "bg-red-500" },
  too_large: { label: "Not saving: the file is too large. Copy your work.", dot: "bg-red-500" },
};

function StatusPill({ status }: { status: ConnectionStatus }) {
  const { label, dot } = STATUS_STYLES[status];
  return (
    <span
      data-testid="connection-status"
      data-status={status}
      role="status"
      className="flex items-center gap-2 rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400"
    >
      <span className={`size-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

interface MemberRow {
  id: string;
  name: string;
  image: string | null;
  online: boolean;
}

function MemberList({
  members,
  presence,
  seenUsers,
  selfId,
}: {
  members: RoomMemberSummary[];
  presence: RemotePresence[];
  seenUsers: PresenceUser[];
  selfId: string;
}) {
  const onlineIds = new Set(presence.map((p) => p.user.id));
  const rows = new Map<string, MemberRow>();
  for (const m of members) rows.set(m.id, { ...m, online: onlineIds.has(m.id) });
  // People who joined after this page loaded are known through presence; they stay listed
  // (as offline) after they leave.
  for (const user of seenUsers) {
    if (!rows.has(user.id)) {
      rows.set(user.id, {
        id: user.id,
        name: user.name,
        image: user.avatar,
        online: onlineIds.has(user.id),
      });
    }
  }
  const sorted = [...rows.values()].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  );

  return (
    <section
      aria-label="Members"
      className="max-h-56 shrink-0 overflow-y-auto border-b border-zinc-200 p-3 dark:border-zinc-800"
    >
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
        Members · {onlineIds.size} online
      </h2>
      <ul className="flex flex-col gap-1.5" data-testid="member-list">
        {sorted.map((m) => (
          <li key={m.id} data-online={m.online} className="flex items-center gap-2 text-sm">
            <span
              className={`size-2 rounded-full ${m.online ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700"}`}
              aria-label={m.online ? "online" : "offline"}
            />
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: colorForUser(m.id) }}
              aria-hidden
            />
            <span className={`truncate ${m.online ? "" : "text-zinc-500"}`}>
              {m.name}
              {m.id === selfId ? " (you)" : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
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
