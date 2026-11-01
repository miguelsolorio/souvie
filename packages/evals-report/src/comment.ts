// Posts the summary on the pull request, once: the comment carries COMMENT_MARKER, and a later run
// edits that comment instead of adding a new one. Uses the GitHub REST API with the workflow's
// GITHUB_TOKEN (the job needs `pull-requests: write`). Never throws: a comment that cannot be
// posted must not turn a green eval red.
import { COMMENT_MARKER } from "./markdown.ts";

export interface CommentTarget {
  /** "owner/name", from GITHUB_REPOSITORY. */
  repository: string;
  pullNumber: number;
  token: string;
  apiUrl?: string;
}

interface ApiComment {
  id: number;
  body?: string;
}

/** The pull request number in the event payload GitHub Actions writes, or null. */
export function pullNumberOf(event: unknown): number | null {
  const number = (event as { pull_request?: { number?: unknown }; number?: unknown } | null)
    ?.pull_request?.number;
  return typeof number === "number" ? number : null;
}

export type CommentResult =
  | { kind: "created" | "updated"; id: number }
  | { kind: "failed"; reason: string };

export async function upsertComment(
  body: string,
  target: CommentTarget,
  doFetch: typeof fetch = fetch,
): Promise<CommentResult> {
  const api = (target.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const base = `${api}/repos/${target.repository}/issues`;
  const headers = {
    Authorization: `Bearer ${target.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  try {
    // The comment that carries the marker, page by page (a busy pull request has many).
    let found: ApiComment | undefined;
    for (let page = 1; page <= 10 && !found; page++) {
      const response = await doFetch(
        `${base}/${target.pullNumber}/comments?per_page=100&page=${page}`,
        {
          headers,
        },
      );
      if (!response.ok)
        return { kind: "failed", reason: `listing comments: HTTP ${response.status}` };
      const comments = (await response.json()) as ApiComment[];
      found = comments.find((comment) => comment.body?.includes(COMMENT_MARKER));
      if (comments.length < 100) break;
    }
    if (found) {
      const response = await doFetch(`${base}/comments/${found.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body }),
      });
      return response.ok
        ? { kind: "updated", id: found.id }
        : { kind: "failed", reason: `updating the comment: HTTP ${response.status}` };
    }
    const response = await doFetch(`${base}/${target.pullNumber}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    });
    if (!response.ok)
      return { kind: "failed", reason: `posting the comment: HTTP ${response.status}` };
    const created = (await response.json()) as ApiComment;
    return { kind: "created", id: created.id };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
