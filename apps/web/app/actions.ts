"use server";

import { signIn, signOut, testAuthEnabled } from "@/auth";
import { safeCallbackPath } from "@/lib/session";

export async function signInWithGitHub(formData: FormData) {
  await signIn("github", { redirectTo: safeCallbackPath(formData.get("callbackUrl")) });
}

export async function signInAsTestUser(formData: FormData) {
  if (!testAuthEnabled()) throw new Error("Test sign-in is disabled");
  await signIn("test", {
    name: formData.get("name"),
    redirectTo: safeCallbackPath(formData.get("callbackUrl")),
  });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}
