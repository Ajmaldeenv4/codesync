import { RUN_LIMITS } from "@codesync/shared";
import { describe, expect, test } from "vitest";
import { CappedBuffer } from "../src/capped-buffer";
import { RateLimiter } from "../src/rate-limit";
import { buildContainerSpec, buildScript, chunkEnv, ENV_CHUNK_CHARS } from "../src/spec";

describe("container spec", () => {
  const spec = buildContainerSpec("python", "print(1)", "");
  const host = spec.HostConfig ?? {};

  test("applies every isolation flag from the spec", () => {
    expect(host.NetworkMode).toBe("none");
    expect(spec.NetworkDisabled).toBe(true);
    expect(host.Memory).toBe(128 * 1024 * 1024);
    expect(host.MemorySwap).toBe(128 * 1024 * 1024);
    expect(host.NanoCpus).toBe(500_000_000);
    expect(host.PidsLimit).toBe(64);
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Tmpfs).toEqual({ "/tmp": "rw,nosuid,nodev,noexec,size=16m,mode=1777" });
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(spec.User).toBe("65534:65534");
    expect(host.Binds ?? []).toEqual([]);
    expect(host.Privileged ?? false).toBe(false);
  });

  test("uses the pinned image per language", () => {
    expect(buildContainerSpec("javascript", "", "").Image).toBe("node:24-alpine");
    expect(spec.Image).toBe("python:3.12-alpine");
  });

  test("code reaches the container only through env vars, never a host mount", () => {
    const env = spec.Env ?? [];
    expect(env.some((e) => e.startsWith("CODESYNC_CODE_0="))).toBe(true);
    expect(JSON.stringify(spec)).not.toContain("print(1)");
  });
});

describe("chunkEnv / buildScript", () => {
  test("splits large payloads below the per-variable limit and round-trips", () => {
    const value = "é".repeat(60_000);
    const { names, env } = chunkEnv("X", value);
    expect(names.length).toBeGreaterThan(1);
    for (const e of env) expect(e.length).toBeLessThanOrEqual(ENV_CHUNK_CHARS + 4);
    const joined = env.map((e) => e.slice(e.indexOf("=") + 1)).join("");
    expect(Buffer.from(joined, "base64").toString("utf8")).toBe(value);
  });

  test("the script decodes, unsets the payload vars, then execs the interpreter", () => {
    const script = buildScript("python", ["C_0", "C_1"], []);
    expect(script).toContain(`printf '%s' "$C_0$C_1" | base64 -d > /tmp/main`);
    expect(script).toContain(": > /tmp/stdin");
    expect(script).toContain("unset C_0 C_1");
    expect(script.trim().endsWith("exec python3 /tmp/main < /tmp/stdin")).toBe(true);
  });
});

describe("CappedBuffer", () => {
  test("keeps exactly `limit` bytes and flags truncation", () => {
    const buffer = new CappedBuffer(10);
    expect(buffer.push(Buffer.from("12345"))).toBe(true);
    expect(buffer.push(Buffer.from("6789012345"))).toBe(false);
    expect(buffer.toString()).toBe("1234567890");
    expect(buffer.truncated).toBe(true);
    expect(buffer.push(Buffer.from("more"))).toBe(false);
    expect(buffer.byteLength).toBe(10);
  });

  test("the default per-stream limit is 64 KB", () => {
    expect(RUN_LIMITS.outputBytes).toBe(65_536);
  });
});

describe("RateLimiter", () => {
  test("allows a burst, then refills over time", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1, () => now);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(1);
    expect(limiter.take("b")).toBe(0);
    now += 1000;
    expect(limiter.take("a")).toBe(0);
  });
});
