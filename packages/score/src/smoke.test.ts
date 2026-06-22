import { describe, expect, it } from "vitest";
import { SCORE_PACKAGE } from "./index";

describe("@vibetrace/score package", () => {
  it("is importable", () => {
    expect(SCORE_PACKAGE).toBe("@vibetrace/score");
  });
});
