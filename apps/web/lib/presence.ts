// Presence helpers shared by the room UI: user colours, parsing awareness states, cursor CSS.

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  avatar: string | null;
}

export interface RemotePresence {
  /** Yjs awareness client id (one per open tab). */
  clientId: number;
  user: PresenceUser;
}

const PALETTE = [
  "#e11d48",
  "#2563eb",
  "#16a34a",
  "#d97706",
  "#9333ea",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#ea580c",
  "#4f46e5",
];

/** Stable colour per user id, so a person keeps their colour across tabs and sessions. */
export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length] ?? "#2563eb";
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function parseUser(value: unknown): PresenceUser | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.name !== "string") return null;
  return {
    id: v.id,
    name: v.name.slice(0, 60),
    // Awareness is client-controlled; only accept a plain hex colour.
    color: typeof v.color === "string" && HEX_COLOR.test(v.color) ? v.color : colorForUser(v.id),
    avatar: typeof v.avatar === "string" ? v.avatar : null,
  };
}

/** Every client with a valid `user` field, including our own. */
export function readPresence(states: Map<number, Record<string, unknown>>): RemotePresence[] {
  const result: RemotePresence[] = [];
  for (const [clientId, state] of states) {
    const user = parseUser(state.user);
    if (user) result.push({ clientId, user });
  }
  return result;
}

/** Escapes text for use inside a double-quoted CSS string in a <style> element. */
export function escapeCssString(text: string): string {
  return text.replace(/[\\"<>\n\r]/g, (ch) => `\\${ch.charCodeAt(0).toString(16)} `);
}

/**
 * Colours and name labels for y-monaco's remote selections. y-monaco tags decorations with
 * `yRemoteSelection-<clientId>` and `yRemoteSelectionHead-<clientId>`; we style each one.
 */
export function remoteCursorCss(presence: RemotePresence[], localClientId: number): string {
  return presence
    .filter((p) => p.clientId !== localClientId && Number.isInteger(p.clientId))
    .map(({ clientId, user }) => {
      const id = String(clientId);
      return [
        `.yRemoteSelection-${id}{background-color:${user.color}33;}`,
        `.yRemoteSelectionHead-${id}{position:absolute;height:100%;box-sizing:border-box;border-left:2px solid ${user.color};}`,
        `.yRemoteSelectionHead-${id}::after{content:"${escapeCssString(user.name)}";position:absolute;top:-1.25em;left:-2px;padding:0 4px;border-radius:3px 3px 3px 0;background:${user.color};color:#fff;font:600 11px/1.25em system-ui,sans-serif;white-space:nowrap;pointer-events:none;z-index:10;}`,
      ].join("");
    })
    .join("\n");
}
