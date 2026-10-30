import { describe, expect, it, vi } from "vitest";
import { pageviewRequest } from "../src/lib/analytics";
import {
  isValidEmail,
  messages,
  normalizeSource,
  submitWaitlist,
  type WaitlistClient,
  type WaitlistRow,
} from "../src/lib/waitlist";

/** A stand-in for supabase-js that behaves like the waitlist table: unique on lower(email). */
function fakeTable() {
  const rows: WaitlistRow[] = [];
  const insert = vi.fn(async (row: WaitlistRow) => {
    if (rows.some((existing) => existing.email.toLowerCase() === row.email.toLowerCase())) {
      return {
        error: { code: "23505", message: "duplicate key value violates unique constraint" },
      };
    }
    rows.push(row);
    return { error: null };
  });
  const client: WaitlistClient = { from: () => ({ insert }) };
  return { rows, insert, getClient: async () => client };
}

describe("submitWaitlist", () => {
  it("inserts one row and confirms", async () => {
    const table = fakeTable();
    const result = await submitWaitlist(
      { email: " Ada@Example.com ", zip: "98019", source: "friends" },
      table.getClient,
    );
    expect(result).toEqual({ status: "joined", message: messages.joined });
    expect(table.rows).toEqual([{ email: "Ada@Example.com", zip: "98019", source: "friends" }]);
  });

  it("stores a missing zip as null and the default source", async () => {
    const table = fakeTable();
    await submitWaitlist({ email: "grace@example.com" }, table.getClient);
    expect(table.rows).toEqual([{ email: "grace@example.com", zip: null, source: "landing" }]);
  });

  it("says You're already on the list for the same email in a different case", async () => {
    const table = fakeTable();
    await submitWaitlist({ email: "ada@example.com" }, table.getClient);
    const again = await submitWaitlist({ email: "ADA@example.com" }, table.getClient);
    expect(again.status).toBe("duplicate");
    expect(again.message).toBe("You're already on the list.");
    expect(table.rows).toHaveLength(1);
  });

  it("does not insert when the honeypot is filled, and still looks like success", async () => {
    const table = fakeTable();
    const getClient = vi.fn(table.getClient);
    const result = await submitWaitlist(
      { email: "bot@example.com", honeypot: "http://spam.example" },
      getClient,
    );
    expect(result.status).toBe("joined");
    expect(table.insert).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
    expect(table.rows).toHaveLength(0);
  });

  it("rejects a bad email or zip before touching the network", async () => {
    const table = fakeTable();
    const getClient = vi.fn(table.getClient);
    expect((await submitWaitlist({ email: "nope" }, getClient)).status).toBe("invalid-email");
    expect((await submitWaitlist({ email: "a@b" }, getClient)).status).toBe("invalid-email");
    expect((await submitWaitlist({ email: "a@b.co", zip: "9801" }, getClient)).status).toBe(
      "invalid-zip",
    );
    expect(getClient).not.toHaveBeenCalled();
  });

  it("reports unavailable when the site was built without Supabase settings", async () => {
    const result = await submitWaitlist({ email: "a@b.co" }, async () => null);
    expect(result).toEqual({ status: "unavailable", message: messages.unavailable });
  });

  it("reports a generic error for any other failure, including a thrown one", async () => {
    const failing: WaitlistClient = {
      from: () => ({ insert: async () => ({ error: { code: "500", message: "boom" } }) }),
    };
    expect((await submitWaitlist({ email: "a@b.co" }, async () => failing)).status).toBe("error");
    const throwing: WaitlistClient = {
      from: () => ({
        insert: () => {
          throw new Error("network down");
        },
      }),
    };
    expect((await submitWaitlist({ email: "a@b.co" }, async () => throwing)).status).toBe("error");
  });
});

describe("helpers", () => {
  it("validates emails the way the table does", () => {
    expect(isValidEmail("ada@example.com")).toBe(true);
    expect(isValidEmail("ada@example")).toBe(false);
    expect(isValidEmail("a da@example.com")).toBe(false);
    expect(isValidEmail(`${"a".repeat(250)}@b.co`)).toBe(false);
  });

  it("turns ?ref= into a value the table accepts", () => {
    expect(normalizeSource(null)).toBe("landing");
    expect(normalizeSource("")).toBe("landing");
    expect(normalizeSource("Product Hunt!")).toBe("product-hunt");
    expect(normalizeSource("r/Seattle")).toBe("r-seattle");
    expect(normalizeSource("x".repeat(100))).toHaveLength(64);
    expect(normalizeSource("friends")).toMatch(/^[a-z0-9._-]{1,64}$/);
  });
});

describe("pageview payload", () => {
  it("is one anonymous $pageview with no person profile", () => {
    const request = pageviewRequest(
      "phc_test",
      "https://example.com/",
      "11111111-1111-4111-8111-111111111111",
    );
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(request.url).toBe("https://us.i.posthog.com/i/v0/e/");
    expect(body).toMatchObject({
      api_key: "phc_test",
      event: "$pageview",
      properties: { $current_url: "https://example.com/", $process_person_profile: false },
    });
  });
});
