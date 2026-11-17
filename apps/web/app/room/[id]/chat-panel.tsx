"use client";

import { CHAT_MAX_LENGTH, type ChatMessage } from "@codesync/shared/doc";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { colorForUser } from "@/lib/presence";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

export function ChatPanel({
  messages,
  selfId,
  onSend,
  disabled,
}: {
  messages: ChatMessage[];
  selfId: string;
  onSend: (text: string) => boolean;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLOListElement>(null);

  // Keep the newest message in view.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (onSend(draft)) setDraft("");
  }

  return (
    <section aria-label="Chat" className="flex min-h-0 flex-1 flex-col" data-testid="chat-panel">
      <ol ref={listRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2">
        {messages.length === 0 ? (
          <li className="text-xs text-zinc-500">No messages yet.</li>
        ) : (
          messages.map((m) => (
            <li key={m.id} className="text-sm" data-testid="chat-message">
              <div className="flex items-baseline gap-2">
                <span className="font-medium" style={{ color: colorForUser(m.userId) }}>
                  {m.userId === selfId ? "You" : m.name}
                </span>
                <time className="text-xs text-zinc-500" dateTime={new Date(m.ts).toISOString()}>
                  {timeFormat.format(m.ts)}
                </time>
              </div>
              <p className="break-words whitespace-pre-wrap">{m.text}</p>
            </li>
          ))
        )}
      </ol>
      <form
        onSubmit={submit}
        className="flex gap-2 border-t border-zinc-200 p-2 dark:border-zinc-800"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={CHAT_MAX_LENGTH}
          placeholder="Message the room"
          aria-label="Chat message"
          disabled={disabled}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
        />
        <button
          type="submit"
          disabled={disabled || draft.trim().length === 0}
          className="rounded-md bg-zinc-900 px-3 py-1 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Send
        </button>
      </form>
    </section>
  );
}
