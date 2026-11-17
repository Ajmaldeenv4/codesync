import { loadEnvFileIfExists } from "@codesync/shared/node";

// Same root .env the app uses in dev; CI sets DATABASE_URL directly.
loadEnvFileIfExists(new URL("../../../.env", import.meta.url));
