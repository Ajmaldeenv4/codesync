// The shape of a room's Y.Doc, shared by the browser, the collab server and the web API.
import * as Y from "yjs";
import { z } from "zod";

/** Y.Text holding the code (the name y-monaco examples use; changing it would orphan old docs). */
export const DOC_TEXT_KEY = "monaco";
/** Y.Array of chat messages, synced and persisted with the code. */
export const DOC_CHAT_KEY = "chat";

/**
 * WebSocket message (beside y-websocket's 0-3) carrying the code the server is about to close the
 * connection with. Render's proxy does not pass close codes on to the browser.
 */
export const MESSAGE_NOTICE = 4;
/** Too much data: reconnect. */
export const CLOSE_POLICY = 1008;
/** The document is too large: don't reconnect. (y-websocket treats 44xx codes as permanent.) */
export const CLOSE_ROOM_FULL = 4413;

export const CHAT_MAX_LENGTH = 2000;

/** Names are cut to this length in chat. */
export const CHAT_NAME_LENGTH = 60;

/** The latest time a JavaScript Date can hold; formatting a later one throws. */
const MAX_TIMESTAMP = 8_640_000_000_000_000;

export const chatMessageSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  userId: z.string().min(1).max(64),
  name: z.string().max(CHAT_NAME_LENGTH),
  // Postgres text cannot hold NUL.
  text: z
    .string()
    .trim()
    .min(1)
    .max(CHAT_MAX_LENGTH)
    .refine((text) => !text.includes("\0")),
  ts: z.number().int().nonnegative().max(MAX_TIMESTAMP),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** Decodes a stored Y.Doc state (snapshot) into its code text. */
export function textFromState(state: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return doc.getText(DOC_TEXT_KEY).toString();
  } finally {
    doc.destroy();
  }
}
