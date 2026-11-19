// Runs one program in a fresh, locked-down container and always removes it afterwards.
import { RUN_LIMITS, type Language, type RunResult } from "@codesync/shared";
import type Docker from "dockerode";
import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";
import { CappedBuffer } from "./capped-buffer";
import { buildContainerSpec, IMAGES, type Limits } from "./spec";

export interface SandboxRunner {
  readonly ready: boolean;
  run(language: Language, code: string, stdin: string): Promise<RunResult>;
}

export class DockerSandbox implements SandboxRunner {
  private imagesReady = false;

  constructor(
    private readonly docker: Docker,
    private readonly limits: Limits = RUN_LIMITS,
  ) {}

  get ready(): boolean {
    return this.imagesReady;
  }

  /** Pulls the language images up front so the first run isn't slow. */
  async prepare(log: (msg: string) => void = console.log): Promise<void> {
    for (const image of new Set(Object.values(IMAGES))) {
      try {
        await this.docker.getImage(image).inspect();
        log(`image ${image} present`);
      } catch {
        log(`pulling ${image}…`);
        const stream = await this.docker.pull(image);
        await new Promise<void>((resolve, reject) =>
          this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())),
        );
        log(`pulled ${image}`);
      }
    }
    this.imagesReady = true;
  }

  async run(language: Language, code: string, stdin: string): Promise<RunResult> {
    const container = await this.docker.createContainer(
      buildContainerSpec(language, code, stdin, this.limits),
    );
    const stdout = new CappedBuffer(this.limits.outputBytes);
    const stderr = new CappedBuffer(this.limits.outputBytes);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flooded: () => void = () => undefined;
    const floodSignal = new Promise<"flood">((resolve) => {
      flooded = () => resolve("flood");
    });

    try {
      // Attach before starting so no output is missed. Non-TTY streams are multiplexed.
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const streamDone = new Promise<void>((resolve) => {
        stream.once("end", resolve);
        stream.once("close", resolve);
        stream.once("error", () => resolve());
      });
      const sink = (buffer: CappedBuffer) =>
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            if (!buffer.push(chunk)) flooded();
            callback();
          },
        });
      this.docker.modem.demuxStream(stream, sink(stdout), sink(stderr));

      await container.start();
      const startedAt = performance.now();
      const exited = container.wait() as Promise<{ StatusCode: number }>;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.limits.timeoutMs);
      });

      const outcome = await Promise.race([exited, deadline, floodSignal]);
      if (outcome === "timeout" || outcome === "flood") {
        await container.kill().catch(() => undefined);
      }
      const { StatusCode } = typeof outcome === "object" ? outcome : await exited;
      const durationMs = Math.round(performance.now() - startedAt);

      // Let buffered output drain (bounded, in case the stream never closes).
      await Promise.race([streamDone, new Promise((resolve) => setTimeout(resolve, 500))]);
      const state = await container
        .inspect()
        .then((info) => info.State)
        .catch(() => undefined);

      return {
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exit_code: StatusCode,
        duration_ms: durationMs,
        timed_out: outcome === "timeout",
        oom_killed: Boolean(state?.OOMKilled),
        output_truncated: stdout.truncated || stderr.truncated,
      };
    } finally {
      clearTimeout(timer);
      await container.remove({ force: true }).catch(() => undefined);
    }
  }
}
