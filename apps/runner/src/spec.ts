// Builds the Docker container for one run. Pure, so the security-relevant flags are unit-tested.
import { RUN_LIMITS, type Language } from "@codesync/shared";
import type { ContainerCreateOptions } from "dockerode";

export const IMAGES: Record<Language, string> = {
  javascript: "node:24-alpine",
  python: "python:3.12-alpine",
};

const INTERPRETERS: Record<Language, string> = {
  javascript: "node",
  python: "python3",
};

/** Linux caps a single environment string at 128 KiB, so large payloads are split. */
export const ENV_CHUNK_CHARS = 60_000;

export type Limits = typeof RUN_LIMITS;

/** Splits base64-encoded `value` into numbered env vars: PREFIX_0, PREFIX_1, ... */
export function chunkEnv(prefix: string, value: string): { names: string[]; env: string[] } {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const names: string[] = [];
  const env: string[] = [];
  for (let i = 0; i * ENV_CHUNK_CHARS < encoded.length; i++) {
    const name = `${prefix}_${i}`;
    names.push(name);
    env.push(`${name}=${encoded.slice(i * ENV_CHUNK_CHARS, (i + 1) * ENV_CHUNK_CHARS)}`);
  }
  return { names, env };
}

/**
 * Shell run as the container's entrypoint: decode the program and stdin from env into the
 * tmpfs, drop those env vars, then replace the shell with the interpreter. No host files are
 * mounted, so this works the same under Docker-in-Docker and on a remote daemon.
 */
export function buildScript(language: Language, codeVars: string[], stdinVars: string[]): string {
  const join = (vars: string[]) => vars.map((v) => `$${v}`).join("");
  const decode = (vars: string[], target: string) =>
    vars.length === 0 ? `: > ${target}` : `printf '%s' "${join(vars)}" | base64 -d > ${target}`;
  const unset = [...codeVars, ...stdinVars];
  return [
    "set -e",
    decode(codeVars, "/tmp/main"),
    decode(stdinVars, "/tmp/stdin"),
    ...(unset.length > 0 ? [`unset ${unset.join(" ")}`] : []),
    `exec ${INTERPRETERS[language]} /tmp/main < /tmp/stdin`,
  ].join("\n");
}

export function buildContainerSpec(
  language: Language,
  code: string,
  stdin: string,
  limits: Limits = RUN_LIMITS,
): ContainerCreateOptions {
  const codeEnv = chunkEnv("CODESYNC_CODE", code);
  const stdinEnv = chunkEnv("CODESYNC_STDIN", stdin);
  return {
    Image: IMAGES[language],
    Cmd: ["sh", "-c", buildScript(language, codeEnv.names, stdinEnv.names)],
    Env: [
      ...codeEnv.env,
      ...stdinEnv.env,
      "HOME=/tmp",
      "PYTHONDONTWRITEBYTECODE=1",
      "PYTHONUNBUFFERED=1",
    ],
    // `nobody`: no root inside the container either.
    User: "65534:65534",
    WorkingDir: "/tmp",
    NetworkDisabled: true,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: false,
    Tty: false,
    Labels: { "codesync.sandbox": "1" },
    HostConfig: {
      // --network=none
      NetworkMode: "none",
      // --memory=128m --memory-swap=128m (no swap on top)
      Memory: limits.memoryBytes,
      MemorySwap: limits.memoryBytes,
      // --cpus=0.5
      NanoCpus: Math.round(limits.cpus * 1e9),
      // --pids-limit=64 (fork bombs hit this)
      PidsLimit: limits.pids,
      // --read-only, with a small writable, non-executable /tmp
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": `rw,nosuid,nodev,noexec,size=${limits.tmpfsMegabytes}m,mode=1777` },
      // --cap-drop=ALL --security-opt no-new-privileges
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Ulimits: [{ Name: "nofile", Soft: 256, Hard: 256 }],
      // Output is streamed through attach; nothing is written to the host's log files.
      LogConfig: { Type: "none", Config: {} },
      // Removed explicitly after the result is collected (equivalent of --rm without racing it).
      AutoRemove: false,
    },
  };
}
