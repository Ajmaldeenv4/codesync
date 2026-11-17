import { getPrisma } from "@codesync/db";
import { roomIdSchema } from "@codesync/shared";
import { listHistory } from "@/lib/history";
import { isMember } from "@/lib/rooms";
import { getCurrentUser } from "@/lib/session";

export async function GET(_request: Request, ctx: RouteContext<"/api/rooms/[id]/history">) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!roomIdSchema.safeParse(id).success) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const db = getPrisma();
  if (!(await isMember(db, id, user.id))) {
    return Response.json({ error: "not_a_member" }, { status: 403 });
  }
  return Response.json({ versions: await listHistory(db, id) });
}
