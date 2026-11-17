// Owns one room's Yjs document and WebSocket provider for the lifetime of the room page.
// React reads it through useSyncExternalStore; the constructor has no side effects so React's
// Strict Mode double-mount is safe (start/stop do the work).
import {
  CHAT_MAX_LENGTH,
  DOC_CHAT_KEY,
  DOC_TEXT_KEY,
  type ChatMessage,
} from "@codesync/shared/doc";
import { ROOM_TOKEN_TTL_SECONDS } from "@codesync/shared/token";
import { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { parseChat } from "./chat";
import { colorForUser, readPresence, type PresenceUser, type RemotePresence } from "./presence";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline";

export interface CollabSnapshot {
  status: ConnectionStatus;
  /** Who is connected right now (one entry per open tab). */
  presence: RemotePresence[];
  /** Everyone seen online during this visit, so people who leave stay listed as offline. */
  seenUsers: PresenceUser[];
  localClientId: number | null;
  text: Y.Text | null;
  awareness: Awareness | null;
  /** Chat history (stored in the same Y.Doc, so it syncs and persists with the code). */
  chat: ChatMessage[];
}

export interface CollabSessionOptions {
  roomId: string;
  collabUrl: string;
  user: { id: string; name: string; image: string | null };
}

/** Refresh well before the room token expires so reconnects always carry a valid one. */
const TOKEN_REFRESH_MS = Math.max(30, ROOM_TOKEN_TTL_SECONDS - 60) * 1000;

const INITIAL: CollabSnapshot = {
  status: "connecting",
  presence: [],
  seenUsers: [],
  localClientId: null,
  text: null,
  awareness: null,
  chat: [],
};

declare global {
  interface Window {
    /** Test hook (non-production only): current document text. */
    __codesyncText?: () => string;
  }
}

export class CollabSession {
  private snapshot = INITIAL;
  private readonly seen = new Map<string, PresenceUser>();
  private readonly listeners = new Set<() => void>();
  private teardown: (() => void) | null = null;
  private chatArray: Y.Array<unknown> | null = null;

  constructor(private readonly options: CollabSessionOptions) {}

  /** Appends a chat message to the shared doc. Returns false if it can't be sent. */
  sendChat(raw: string): boolean {
    const text = raw.trim();
    if (!this.chatArray || text.length === 0 || text.length > CHAT_MAX_LENGTH) return false;
    const { user } = this.options;
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      userId: user.id,
      name: user.name,
      text,
      ts: Date.now(),
    };
    this.chatArray.push([message]);
    return true;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CollabSnapshot => this.snapshot;

  start(): void {
    if (this.teardown) return;
    const { roomId, collabUrl, user } = this.options;
    const doc = new Y.Doc();
    const text = doc.getText(DOC_TEXT_KEY);
    const chatArray = doc.getArray<unknown>(DOC_CHAT_KEY);
    this.chatArray = chatArray;
    const onChat = () => this.update({ chat: parseChat(chatArray.toArray()) });
    chatArray.observe(onChat);
    const provider = new WebsocketProvider(collabUrl, roomId, doc, {
      connect: false,
      // Always go through the server (no same-browser BroadcastChannel shortcut).
      disableBc: true,
    });
    const { awareness } = provider;
    awareness.setLocalStateField("user", {
      id: user.id,
      name: user.name,
      color: colorForUser(user.id),
      avatar: user.image,
    });

    let disposed = false;
    let everConnected = false;

    const refreshToken = async () => {
      const res = await fetch(`/api/rooms/${roomId}/token`, { cache: "no-store" });
      if (!res.ok) throw new Error(`token request failed: ${res.status}`);
      const { token } = (await res.json()) as { token: string };
      // y-websocket rebuilds its URL from params on every (re)connect.
      provider.params = { token };
    };

    const onStatus = ({ status }: { status: "connected" | "disconnected" | "connecting" }) => {
      if (status === "connected") everConnected = true;
      this.update({ status: this.describe(status, everConnected) });
    };
    // A dropped connection may be an expired token; fetch a fresh one before the retry.
    const onClose = () => void refreshToken().catch(() => undefined);
    const onAwareness = () => this.update(this.presenceState(readPresence(awareness.getStates())));
    const onNetwork = () =>
      this.update({
        status: this.describe(provider.wsconnected ? "connected" : "connecting", everConnected),
      });

    provider.on("status", onStatus);
    provider.on("connection-close", onClose);
    awareness.on("change", onAwareness);
    window.addEventListener("online", onNetwork);
    window.addEventListener("offline", onNetwork);
    const refreshTimer = setInterval(
      () => void refreshToken().catch(() => undefined),
      TOKEN_REFRESH_MS,
    );

    if (process.env.NODE_ENV !== "production") window.__codesyncText = () => text.toString();

    this.update({
      status: "connecting",
      text,
      awareness,
      localClientId: doc.clientID,
      ...this.presenceState(readPresence(awareness.getStates())),
    });

    refreshToken()
      .then(() => {
        if (!disposed) provider.connect();
      })
      .catch(() => {
        if (!disposed) this.update({ status: "offline" });
      });

    this.teardown = () => {
      disposed = true;
      this.chatArray = null;
      chatArray.unobserve(onChat);
      clearInterval(refreshTimer);
      window.removeEventListener("online", onNetwork);
      window.removeEventListener("offline", onNetwork);
      awareness.off("change", onAwareness);
      provider.off("status", onStatus);
      provider.off("connection-close", onClose);
      provider.destroy();
      doc.destroy();
      if (window.__codesyncText) delete window.__codesyncText;
    };
  }

  stop(): void {
    this.teardown?.();
    this.teardown = null;
    this.update(INITIAL);
  }

  private describe(
    status: "connected" | "disconnected" | "connecting",
    everConnected: boolean,
  ): ConnectionStatus {
    if (status === "connected") return "connected";
    if (!navigator.onLine) return "offline";
    return everConnected ? "reconnecting" : "connecting";
  }

  private presenceState(presence: RemotePresence[]) {
    for (const { user } of presence) this.seen.set(user.id, user);
    return { presence, seenUsers: [...this.seen.values()] };
  }

  private update(patch: Partial<CollabSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
