// Copies the secrets in .env.deploy.vercel (git-ignored) to the Vercel project's Production
// environment. Values go through stdin, so they never appear on a command line or on screen.
// Usage: node scripts/push-vercel-secrets.mjs
import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import { parseEnv } from "node:util";

const PROJECT = "codesync";
const SCOPE = "ajmaltracker";
const SECRETS = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "AUTH_GITHUB_SECRET",
  "WS_TOKEN_SECRET",
  "COLLAB_INTERNAL_SECRET",
  "RUNNER_HMAC_KEY",
];

const env = parseEnv(readFileSync(new URL("../.env.deploy.vercel", import.meta.url), "utf8"));
const missing = SECRETS.filter((name) => !env[name]);
if (missing.length > 0) {
  console.error(`Nothing was sent. Missing in .env.deploy.vercel: ${missing.join(", ")}`);
  process.exit(1);
}

let failed = 0;
for (const name of SECRETS) {
  // One fixed command string: only constants from this file reach the shell.
  const command =
    `npx --yes vercel@66.6.0 env add ${name} --environment production --type secret ` +
    `--force --yes --project ${PROJECT} --scope ${SCOPE}`;
  const result = spawnSync(command, { shell: true, input: env[name], encoding: "utf8" });
  if (result.status === 0) {
    console.log(`added  ${name}`);
  } else {
    failed += 1;
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replaceAll(env[name], "<hidden>");
    console.error(`FAILED ${name}\n${output.trim()}`);
  }
}
console.log(failed === 0 ? "All secrets are in Vercel." : `${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
