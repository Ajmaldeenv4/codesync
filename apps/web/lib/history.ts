// Room history: compacted snapshots written by the collab server, read and restored from here.
import type { PrismaClient } from "@codesync/db";
import { textFromState } from "@codesync/shared/doc";
import { SIGNATURE_HEADER, signRequest } from "@codesync/shared/hmac";

export interface HistoryEntry {
  version: number;
  createdAt: Date;
}

export async function listHistory(
  db: PrismaClient,
  roomId: string,
  limit = 100,
): Promise<HistoryEntry[]> {
  return db.snapshot.findMany({
    where: { roomId },
    orderBy: { version: "desc" },
    take: limit,
    select: { version: true, createdAt: true },
  });
}

export async function getHistoryVersion(
  db: PrismaClient,
  roomId: string,
  version: number,
): Promise<(HistoryEntry & { text: string }) | null> {
  const row = await db.snapshot.findUnique({
    where: { roomId_version: { roomId, version } },
    select: { version: true, createdAt: true, state: true },
  });
  if (!row) return null;
  return { version: row.version, createdAt: row.createdAt, text: textFromState(row.state) };
}

/** The collab server's HTTP base: COLLAB_INTERNAL_URL, else derived from the public ws:// URL. */
export function collabInternalUrl(env: {
  COLLAB_INTERNAL_URL?: string | undefined;
  NEXT_PUBLIC_COLLAB_URL?: string | undefined;
}): string {
  if (env.COLLAB_INTERNAL_URL) return env.COLLAB_INTERNAL_URL.replace(/\/+$/, "");
  const ws = env.NEXT_PUBLIC_COLLAB_URL ?? "ws://localhost:1234";
  return ws.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}

export type RestoreResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Asks the collab server to restore a version. It owns the live document, so the restore
 * happens there and reaches connected clients as a normal edit. The caller must have already
 * checked that the user owns the room.
 */
export async function requestRestore(roomId: string, version: number): Promise<RestoreResult> {
  const secret = process.env.COLLAB_INTERNAL_SECRET;
  if (!secret) return { ok: false, status: 500, error: "server_misconfigured" };

  const body = JSON.stringify({ version });
  const base = collabInternalUrl({
    COLLAB_INTERNAL_URL: process.env.COLLAB_INTERNAL_URL,
    NEXT_PUBLIC_COLLAB_URL: process.env.NEXT_PUBLIC_COLLAB_URL,
  });
  let res: Response;
  try {
    res = await fetch(`${base}/internal/rooms/${roomId}/restore`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signRequest(body, secret),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 502, error: "collab_unreachable" };
  }
  if (res.ok) return { ok: true };
  if (res.status === 404) return { ok: false, status: 404, error: "version_not_found" };
  return { ok: false, status: 502, error: "restore_failed" };
}
