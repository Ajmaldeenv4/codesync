// What one person, room or connection may use. Any signed-in GitHub user can reach this server, and
// it runs in 512 MB, so nothing a client controls may grow without bound.

export interface BucketOptions {
  /** Most that can be used at once. */
  capacity: number;
  /** How fast it refills. */
  perSecond: number;
}

export interface CollabLimits {
  /** Document size above which only small edits (such as deleting text) are accepted. */
  docBytes: number;
  /** Document size above which nothing is accepted. */
  docBytesHard: number;
  /** Largest WebSocket message. Must fit a whole document, which clients resend after a crash. */
  messageBytes: number;
  connections: number;
  connectionsPerRoom: number;
  connectionsPerUser: number;
  /** Unsent data allowed to build up for a client that reads slowly. */
  bufferedBytes: number;
  /** Awareness ids one connection may control at once (a browser tab uses one). */
  presencePerConnection: number;
  /** Largest awareness state (name, colour, cursor), as JSON. */
  presenceBytes: number;
  /** Per user, across all their connections. */
  userConnects: BucketOptions;
  userMessages: BucketOptions;
  userBytes: BucketOptions;
  userReplyBytes: BucketOptions;
  userChat: BucketOptions;
}

const KB = 1024;
const MB = 1024 * KB;

export const DEFAULT_LIMITS: CollabLimits = {
  docBytes: 1 * MB,
  docBytesHard: 1.25 * MB,
  messageBytes: 1.5 * MB,
  connections: 500,
  connectionsPerRoom: 250,
  connectionsPerUser: 10,
  bufferedBytes: 4 * MB,
  presencePerConnection: 4,
  presenceBytes: 4 * KB,
  userConnects: { capacity: 30, perSecond: 1 },
  // y-websocket repeats everyone's cursor moves back to the server, so busy rooms are chatty.
  userMessages: { capacity: 3000, perSecond: 300 },
  userBytes: { capacity: 4 * MB, perSecond: 256 * KB },
  userReplyBytes: { capacity: 16 * MB, perSecond: 512 * KB },
  userChat: { capacity: 20, perSecond: 1 },
};

/** Edits up to this size are still accepted between docBytes and docBytesHard. */
export const SMALL_EDIT_BYTES = 1 * KB;

/** Close codes: y-websocket reconnects after POLICY, and gives up after ROOM_FULL (44xx). */
export const CLOSE_POLICY = 1008;
export const CLOSE_ROOM_FULL = 4413;

/** Thrown while handling a message to close that connection with a specific code. */
export class LimitError extends Error {
  constructor(
    readonly closeCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** A token bucket per key. */
export class KeyedBucket {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly options: BucketOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** Uses `cost` tokens if they are available; otherwise uses nothing and returns false. */
  take(key: string, cost = 1): boolean {
    const { capacity, perSecond } = this.options;
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: now };
    const refilled = bucket.tokens + ((now - bucket.updatedAt) / 1000) * perSecond;
    bucket.tokens = Math.min(capacity, refilled);
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);
    if (this.buckets.size >= 1000) this.prune(now);
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  /** Forgets keys that have refilled, so the map stays small. */
  private prune(now: number): void {
    const { capacity, perSecond } = this.options;
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((now - b.updatedAt) / 1000) * perSecond >= capacity) this.buckets.delete(key);
    }
  }
}

/** The per-user buckets, shared by every room. */
export class UserLimits {
  readonly connects: KeyedBucket;
  readonly messages: KeyedBucket;
  readonly bytes: KeyedBucket;
  readonly replyBytes: KeyedBucket;
  readonly chat: KeyedBucket;

  constructor(limits: CollabLimits) {
    this.connects = new KeyedBucket(limits.userConnects);
    this.messages = new KeyedBucket(limits.userMessages);
    this.bytes = new KeyedBucket(limits.userBytes);
    this.replyBytes = new KeyedBucket(limits.userReplyBytes);
    this.chat = new KeyedBucket(limits.userChat);
  }
}
