// The shape of a room's Y.Doc, shared by the browser, the collab server and the web API.
import * as Y from "yjs";
import { z } from "zod";

/** Y.Text holding the code (the name y-monaco examples use; changing it would orphan old docs). */
export const DOC_TEXT_KEY = "monaco";
/** Y.Array of chat messages, synced and persisted with the code. */
export const DOC_CHAT_KEY = "chat";

export const CHAT_MAX_LENGTH = 2000;

export const chatMessageSchema = z.object({
  id: z.string().min(8).max(64),
  userId: z.string().min(1).max(64),
  name: z.string().max(60),
  text: z.string().trim().min(1).max(CHAT_MAX_LENGTH),
  ts: z.number().int().nonnegative(),
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
