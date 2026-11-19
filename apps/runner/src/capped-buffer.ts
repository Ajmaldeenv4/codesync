/** Collects bytes up to a fixed limit; anything past it is dropped and `truncated` is set. */
export class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  /** Returns false once the limit has been reached. */
  push(chunk: Buffer): boolean {
    if (this.truncated) return false;
    const room = this.limit - this.size;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size = this.limit;
      this.truncated = true;
      return false;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    return true;
  }

  get byteLength(): number {
    return this.size;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}
