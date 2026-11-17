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

/** Creates a room owned by `ownerId` and makes the owner its first member. */
export function createRoom(
  db: PrismaClient,
  ownerId: string,
  input: CreateRoomInput,
): Promise<RoomSummary> {
  return db.room.create({
    data: {
      id: nanoid(ROOM_ID_LENGTH),
      name: input.name,
      language: input.language,
      ownerId,
      members: { create: { userId: ownerId } },
    },
    select: roomSelect,
  });
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
