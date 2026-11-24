import { chatMessageSchema, type ChatMessage } from "@codesync/shared/doc";

/** Keeps the valid messages (the array is client-writable), newest `limit` only. */
export function parseChat(items: unknown[], limit = 200): ChatMessage[] {
  const messages = new Map<string, ChatMessage>();
  for (const item of items.slice(-limit)) {
    const parsed = chatMessageSchema.safeParse(item);
    if (parsed.success && !messages.has(parsed.data.id)) messages.set(parsed.data.id, parsed.data);
  }
  return [...messages.values()];
}
