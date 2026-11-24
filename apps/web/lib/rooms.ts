// Room data access. Takes the Prisma client as an argument so tests can run it against a real DB.
import type { PrismaClient } from "@codesync/db";
import { ROOM_ID_LENGTH, type CreateRoomInput, type Language } from "@codesync/shared";
import { nanoid } from "nanoid";

export interface RoomSummary {
  id: string;
  name: string;
  language: Language;
  ownerId: string;
  createdAt: Date;
}

export interface RecentRoom extends RoomSummary {
  lastSeenAt: Date;
}

const roomSelect = {
  id: true,
  name: true,
  language: true,
  ownerId: true,
  createdAt: true,
} as const;

/** Rooms one user may create. Storage is shared by everyone, and each room uses some. */
export const ROOM_LIMITS = { perHour: 20, total: 50 };

export class RoomLimitError extends Error {
  constructor(readonly code: "too_many_rooms_recently" | "room_limit") {
    super(code);
  }
}

/** Creates a room owned by `ownerId` and makes the owner its first member. */
export function createRoom(
  db: PrismaClient,
  ownerId: string,
  input: CreateRoomInput,
  limits = ROOM_LIMITS,
): Promise<RoomSummary> {
  return db.$transaction(
    async (tx) => {
      // One at a time per user, so parallel requests can't all pass the checks below.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rooms:${ownerId}`}, 0))`;
      if ((await tx.room.count({ where: { ownerId } })) >= limits.total) {
        throw new RoomLimitError("room_limit");
      }
      const hourAgo = new Date(Date.now() - 60 * 60_000);
      const recent = { ownerId, createdAt: { gt: hourAgo } };
      if ((await tx.room.count({ where: recent })) >= limits.perHour) {
        throw new RoomLimitError("too_many_rooms_recently");
      }
      return tx.room.create({
        data: {
          id: nanoid(ROOM_ID_LENGTH),
          name: input.name,
          language: input.language,
          ownerId,
          members: { create: { userId: ownerId } },
        },
        select: roomSelect,
      });
    },
    // A sleeping serverless database (Neon) needs a few seconds to wake.
    { maxWait: 15_000, timeout: 20_000 },
  );
}

export function getRoom(db: PrismaClient, id: string): Promise<RoomSummary | null> {
  return db.room.findUnique({ where: { id }, select: roomSelect });
}

/** Adds the user to the room, or bumps lastSeenAt if they're already a member. */
export async function joinRoom(db: PrismaClient, roomId: string, userId: string): Promise<void> {
  await db.roomMember.upsert({
    where: { roomId_userId: { roomId, userId } },
    create: { roomId, userId },
    update: { lastSeenAt: new Date() },
  });
}

export async function isMember(db: PrismaClient, roomId: string, userId: string): Promise<boolean> {
  const row = await db.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
    select: { roomId: true },
  });
  return row !== null;
}

/** Rooms the user owns or has joined, most recently visited first. */
export async function listRecentRooms(
  db: PrismaClient,
  userId: string,
  limit = 20,
): Promise<RecentRoom[]> {
  const rows = await db.roomMember.findMany({
    where: { userId },
    orderBy: { lastSeenAt: "desc" },
    take: limit,
    select: { lastSeenAt: true, room: { select: roomSelect } },
  });
  return rows.map(({ room, lastSeenAt }) => ({ ...room, lastSeenAt }));
}

export interface RoomMemberSummary {
  id: string;
  name: string;
  image: string | null;
}

/** Everyone who has joined the room, in join order. */
export async function listRoomMembers(
  db: PrismaClient,
  roomId: string,
): Promise<RoomMemberSummary[]> {
  const rows = await db.roomMember.findMany({
    where: { roomId },
    orderBy: { joinedAt: "asc" },
    select: { user: { select: { id: true, name: true, email: true, image: true } } },
  });
  return rows.map(({ user }) => ({
    id: user.id,
    name: user.name ?? user.email ?? "Anonymous",
    image: user.image,
  }));
}
