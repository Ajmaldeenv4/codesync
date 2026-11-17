// Short-lived room tokens: Next.js signs one for a room member, the collab server verifies it
// on the WebSocket upgrade. HS256 with a secret shared only between those two services.
import { errors, jwtVerify, SignJWT } from "jose";
import { z } from "zod";

export const ROOM_TOKEN_TTL_SECONDS = 300;
const ISSUER = "codesync-web";
const AUDIENCE = "codesync-collab";
const MIN_SECRET_LENGTH = 32;

export interface RoomTokenClaims {
  /** User id. */
  sub: string;
  roomId: string;
  name: string;
  avatar: string | null;
}

export type VerifyRoomTokenResult =
  | { ok: true; claims: RoomTokenClaims }
  | { ok: false; reason: "expired" | "invalid" | "wrong_room" };

const payloadSchema = z.object({
  sub: z.string().min(1),
  roomId: z.string().min(1),
  name: z.string(),
  avatar: z.string().nullable(),
});

function keyFrom(secret: string): Uint8Array {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`Room token secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return new TextEncoder().encode(secret);
}

export async function signRoomToken(
  claims: RoomTokenClaims,
  secret: string,
  ttlSeconds: number = ROOM_TOKEN_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({ roomId: claims.roomId, name: claims.name, avatar: claims.avatar })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(keyFrom(secret));
}

export async function verifyRoomToken(
  token: string,
  secret: string,
  expectedRoomId: string,
): Promise<VerifyRoomTokenResult> {
  const key = keyFrom(secret);
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
    }));
  } catch (err) {
    return { ok: false, reason: err instanceof errors.JWTExpired ? "expired" : "invalid" };
  }

  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (parsed.data.roomId !== expectedRoomId) return { ok: false, reason: "wrong_room" };
  return { ok: true, claims: parsed.data };
}
