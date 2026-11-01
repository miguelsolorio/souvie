// Acceptance criterion 8 (the comment half): one comment per pull request, edited on later runs,
// and a failure to post never throws.
import { describe, expect, it } from "vitest";
import { pullNumberOf, upsertComment } from "./comment.ts";
import { COMMENT_MARKER } from "./markdown.ts";

const TARGET = { repository: "miguelsolorio/souvie", pullNumber: 31, token: "gh-token" };

function api(existing: Array<{ id: number; body: string }>, ok = { list: true, write: true }) {
  const calls: Array<{ method: string; url: string; body?: unknown; auth?: string }> = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      method,
      url,
      auth: headers?.Authorization,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (method === "GET") {
      return ok.list ? Response.json(existing) : new Response("no", { status: 403 });
    }
    return ok.write ? Response.json({ id: 900 }) : new Response("no", { status: 422 });
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

describe("upsertComment", () => {
  it("posts a new comment when there is none of ours", async () => {
    const { doFetch, calls } = api([{ id: 1, body: "looks good" }]);
    const result = await upsertComment(`${COMMENT_MARKER}\nbody`, TARGET, doFetch);
    expect(result).toEqual({ kind: "created", id: 900 });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      [
        "GET",
        "https://api.github.com/repos/miguelsolorio/souvie/issues/31/comments?per_page=100&page=1",
      ],
      ["POST", "https://api.github.com/repos/miguelsolorio/souvie/issues/31/comments"],
    ]);
    expect(calls[1]?.body).toEqual({ body: `${COMMENT_MARKER}\nbody` });
    expect(calls[1]?.auth).toBe("Bearer gh-token");
  });

  it("edits the comment that carries the marker instead of adding another", async () => {
    const { doFetch, calls } = api([
      { id: 1, body: "looks good" },
      { id: 7, body: `${COMMENT_MARKER}\nold numbers` },
    ]);
    const result = await upsertComment(`${COMMENT_MARKER}\nnew numbers`, TARGET, doFetch);
    expect(result).toEqual({ kind: "updated", id: 7 });
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      url: "https://api.github.com/repos/miguelsolorio/souvie/issues/comments/7",
    });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("reports a failure, and does not throw, when GitHub refuses or is unreachable", async () => {
    const listing = api([], { list: false, write: true });
    expect(await upsertComment("x", TARGET, listing.doFetch)).toEqual({
      kind: "failed",
      reason: "listing comments: HTTP 403",
    });
    const writing = api([], { list: true, write: false });
    expect(await upsertComment("x", TARGET, writing.doFetch)).toEqual({
      kind: "failed",
      reason: "posting the comment: HTTP 422",
    });
    const down = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await upsertComment("x", TARGET, down)).toEqual({
      kind: "failed",
      reason: "network down",
    });
  });
});

describe("pullNumberOf", () => {
  it("reads the number from a pull request event and is null for any other", () => {
    expect(pullNumberOf({ pull_request: { number: 31 } })).toBe(31);
    expect(pullNumberOf({ ref: "refs/heads/main" })).toBeNull();
    expect(pullNumberOf(null)).toBeNull();
  });
});
