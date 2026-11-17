import { getPrisma } from "@codesync/db";
import { roomIdSchema } from "@codesync/shared";
import { getRoom } from "@/lib/rooms";
import { getCurrentUser } from "@/lib/session";

export async function GET(_request: Request, ctx: RouteContext<"/api/rooms/[id]">) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!roomIdSchema.safeParse(id).success) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const room = await getRoom(getPrisma(), id);
  if (!room) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ room });
}
