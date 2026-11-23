import { getPrisma } from "@codesync/db";
import { RUN_LIMITS, runRequestSchema, utf8Length } from "@codesync/shared";
import { getRoom, isMember } from "@/lib/rooms";
import { requestRun } from "@/lib/runner";
import { getCurrentUser } from "@/lib/session";

/** Seconds: covers waking a stopped runner plus one run. */
export const maxDuration = 60;

/** Runs the room's code in the sandbox. Members only; the language comes from the room. */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = runRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { roomId, code, stdin = "" } = parsed.data;

  if (utf8Length(code) > RUN_LIMITS.codeBytes) {
    return Response.json({ error: "code_too_large", limit: RUN_LIMITS.codeBytes }, { status: 413 });
  }
  if (utf8Length(stdin) > RUN_LIMITS.stdinBytes) {
    return Response.json(
      { error: "stdin_too_large", limit: RUN_LIMITS.stdinBytes },
      { status: 413 },
    );
  }

  const db = getPrisma();
  const room = await getRoom(db, roomId);
  if (!room) return Response.json({ error: "not_found" }, { status: 404 });
  if (!(await isMember(db, roomId, user.id))) {
    return Response.json({ error: "not_a_member" }, { status: 403 });
  }

  const response = await requestRun({ userId: user.id, language: room.language, code, stdin });
  if (response.ok) return Response.json(response.result);
  return Response.json(response.body, {
    status: response.status,
    headers: response.retryAfter ? { "retry-after": response.retryAfter } : undefined,
  });
}
