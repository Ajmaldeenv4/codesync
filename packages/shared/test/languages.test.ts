import { describe, expect, test } from "vitest";
import { isLanguage, LANGUAGES } from "../src/index";

describe("isLanguage", () => {
  test("accepts every supported language", () => {
    for (const lang of LANGUAGES) expect(isLanguage(lang)).toBe(true);
  });

  test("rejects anything else", () => {
    for (const value of ["typescript", "", "JavaScript", 1, null, undefined]) {
      expect(isLanguage(value)).toBe(false);
    }
  });
});
