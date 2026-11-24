"use client";

import { LANGUAGES, type Language } from "@codesync/shared";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

const LANGUAGE_LABELS: Record<Language, string> = { javascript: "JavaScript", python: "Python" };

const LIMIT_MESSAGES: Record<string, string> = {
  too_many_rooms_recently: "You've created a lot of rooms. Wait an hour and try again.",
  room_limit: "You've reached the most rooms one person can own. Reuse one of yours.",
};

interface CreateRoomResponse {
  room?: { id: string };
  error?: string;
  issues?: { name?: string[] };
}

export function NewRoomForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.get("name"), language: form.get("language") }),
      });
      const data = (await res.json()) as CreateRoomResponse;
      if (!res.ok || !data.room) {
        setError(
          data.issues?.name?.[0] ??
            LIMIT_MESSAGES[data.error ?? ""] ??
            "Couldn't create the room. Try again.",
        );
        setPending(false);
        return;
      }
      router.push(`/room/${data.room.id}`);
    } catch {
      setError("Network error. Check your connection and try again.");
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800"
    >
      <h2 className="text-lg font-semibold">New room</h2>
      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Name</span>
          <input
            name="name"
            required
            maxLength={80}
            placeholder="Interview prep"
            className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Language</span>
          <select
            name="language"
            defaultValue="javascript"
            className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {LANGUAGE_LABELS[lang]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="self-end rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {pending ? "Creating…" : "Create room"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
