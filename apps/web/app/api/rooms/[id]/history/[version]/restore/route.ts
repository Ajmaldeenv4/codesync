import { getPrisma } from "@codesync/db";
import { roomIdSchema } from "@codesync/shared";
import { requestRestore } from "@/lib/history";
import { getRoom } from "@/lib/rooms";
import { getCurrentUser } from "@/lib/session";

/** Owner-only: replace the live code with this version (done by the collab server). */
export async function POST(
  _request: Request,
  ctx: RouteContext<"/api/rooms/[id]/history/[version]/restore">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id, version } = await ctx.params;
  const versionNumber = Number(version);
  if (
    !roomIdSchema.safeParse(id).success ||
    !Number.isInteger(versionNumber) ||
    versionNumber < 1
  ) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const room = await getRoom(getPrisma(), id);
  if (!room) return Response.json({ error: "not_found" }, { status: 404 });
  if (room.ownerId !== user.id) {
    return Response.json({ error: "owner_only" }, { status: 403 });
  }

  const result = await requestRestore(id, versionNumber);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true, version: versionNumber });
}
