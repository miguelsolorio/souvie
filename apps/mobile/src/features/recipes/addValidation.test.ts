import { ImportError, RecipeError } from "@mp/db";
import { describe, expect, it } from "vitest";
import {
  describeFailure,
  duplicateCheckFor,
  duplicateOf,
  linkProblem,
  NOT_A_WEB_ADDRESS,
  pasteStatus,
} from "./addValidation";

describe("linkProblem", () => {
  it("has nothing to say about an empty box", () => {
    expect(linkProblem("")).toBeNull();
    expect(linkProblem("   ")).toBeNull();
  });

  it("accepts http and https addresses, with the spaces around them trimmed", () => {
    expect(linkProblem("https://www.seriouseats.com/lemon-chicken")).toBeNull();
    expect(linkProblem("http://example.com")).toBeNull();
    expect(linkProblem("  HTTPS://Example.com/r?a=1#top ")).toBeNull();
  });

  it("says it is not a web address for anything else", () => {
    expect(NOT_A_WEB_ADDRESS).toBe("That is not a web address");
    for (const text of [
      "seriouseats.com/recipes/x",
      "www.example.com",
      "lemon chicken",
      "ftp://example.com",
      "javascript:alert(1)",
      "data:text/html,<p>x</p>",
      "file:///etc/passwd",
      "https://",
      "http:// example.com",
      "https://exa mple.com",
    ]) {
      expect(linkProblem(text), text).toBe("That is not a web address");
    }
  });

  it("agrees with what the function accepts: the same HttpUrl", () => {
    // A link long enough to be refused by the function's limit is refused here too.
    expect(linkProblem(`https://example.com/${"a".repeat(2100)}`)).toBe(NOT_A_WEB_ADDRESS);
  });
});

describe("pasteStatus", () => {
  it("is ready at the function's minimum of 20 characters, not before", () => {
    expect(pasteStatus("x".repeat(19)).ready).toBe(false);
    expect(pasteStatus("x".repeat(20))).toEqual({ ready: true, hint: null });
    expect(pasteStatus(`  ${"x".repeat(19)}  `).ready).toBe(false);
  });

  it("says why it is not ready", () => {
    expect(pasteStatus("").hint).toBe(
      "Paste at least 20 characters: a title, the ingredients, and the steps.",
    );
    expect(pasteStatus("x".repeat(12)).hint).toBe(
      "8 more characters needed. A recipe takes at least 20.",
    );
    expect(pasteStatus("x".repeat(19)).hint).toBe(
      "1 more character needed. A recipe takes at least 20.",
    );
  });

  it("uses no em dashes", () => {
    const dash = String.fromCharCode(0x2014);
    for (const text of ["", "abc"]) expect(pasteStatus(text).hint).not.toContain(dash);
  });
});

describe("describeFailure", () => {
  it("shows the function's own message for an import failure, not a generic line", () => {
    const error = new ImportError("invalid_request", "That address uses an unusual port.");
    expect(describeFailure(error)).toBe("That address uses an unusual port.");
    expect(describeFailure(new ImportError("blocked", "The site would not let us in."))).toBe(
      "The site would not let us in.",
    );
  });

  it("uses the table's text for a code when the function sent no message", () => {
    expect(describeFailure(new ImportError("rate_limited"))).toMatch(/importing too fast/);
    expect(describeFailure(new ImportError("cost_cap"))).toMatch(/today's limit/);
  });

  it("words a failed save", () => {
    expect(describeFailure(new RecipeError("not_found"))).toMatch(/gone/);
    expect(describeFailure(new RecipeError("invalid"))).toMatch(
      /title and at least one ingredient/,
    );
  });

  it("shows the message of any other error that has one, and only then the generic line", () => {
    expect(describeFailure(new Error("Pick a photo under 5 MB."))).toBe("Pick a photo under 5 MB.");
    expect(describeFailure(new Error(""))).toMatch(/Something went wrong/);
    expect(describeFailure("boom")).toMatch(/Something went wrong/);
    expect(describeFailure(undefined)).toMatch(/Something went wrong/);
  });
});

describe("duplicateOf", () => {
  const existing = { recipeId: "old-1", matchedBy: "title" as const };

  it("reads the existing recipe from an import failure and from a failed save", () => {
    expect(duplicateOf(new ImportError("duplicate", undefined, undefined, existing))).toEqual(
      existing,
    );
    expect(duplicateOf(new RecipeError("duplicate", undefined, existing))).toEqual(existing);
  });

  it("is null for anything else, including a duplicate that does not say which recipe", () => {
    expect(duplicateOf(null)).toBeNull();
    expect(duplicateOf(undefined)).toBeNull();
    expect(duplicateOf(new Error("duplicate"))).toBeNull();
    expect(duplicateOf(new ImportError("blocked"))).toBeNull();
    expect(duplicateOf(new RecipeError("unknown"))).toBeNull();
    expect(duplicateOf(new ImportError("duplicate"))).toBeNull();
  });
});

describe("duplicateCheckFor", () => {
  it("keys a recipe with a link by that link, in the form the database stores", () => {
    expect(duplicateCheckFor("Pancakes", "https://Www.Instagram.com/reel/abc/?igsh=x#top")).toEqual(
      { sourceUrlNormalized: "https://www.instagram.com/reel/abc" },
    );
  });

  it("keys a recipe without one by its title, with case and spacing folded", () => {
    const check = duplicateCheckFor("  Lemon   CHICKEN ");
    expect(check).not.toHaveProperty("sourceUrlNormalized");
    const { title } = check as { title: { pattern: string; isSame: (c: string) => boolean } };
    expect(title.pattern).toBe("lemon%chicken");
    expect(title.isSame("lemon chicken")).toBe(true);
    expect(title.isSame("LEMON\tCHICKEN")).toBe(true);
    expect(title.isSame("Lemon roast chicken")).toBe(false);
  });

  it("falls back to the title when the link is not one it can key", () => {
    expect(duplicateCheckFor("Soup", "not a link")).toHaveProperty("title");
  });
});
