import { getPrisma } from "@codesync/db";
import { roomIdSchema } from "@codesync/shared";
import { getHistoryVersion } from "@/lib/history";
import { isMember } from "@/lib/rooms";
import { getCurrentUser } from "@/lib/session";

/** Read-only preview of one version's code. */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/rooms/[id]/history/[version]">,
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
  const db = getPrisma();
  if (!(await isMember(db, id, user.id))) {
    return Response.json({ error: "not_a_member" }, { status: 403 });
  }
  const entry = await getHistoryVersion(db, id, versionNumber);
  if (!entry) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(entry);
}
