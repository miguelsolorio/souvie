// A one-slot inbox between the share-sheet receiver and the add-recipe screen (WS02).
//
// The receiver (ShareIntentReceiver) lives high in the tree and runs whenever something is shared
// into the app. The add screen reads what arrived. The caption can be long, so it travels here
// and not in a route parameter (a URL).

import { splitSharedText } from "@mp/recipe-import/share";

export interface SharedInput {
  /** The caption or message text, without the link. May be empty (a bare link). */
  text: string;
  /** The first web link in the share, if any. */
  url: string | null;
  receivedAt: number;
}

/** The part of expo-share-intent's `ShareIntent` this module reads. */
export interface IncomingShare {
  type?: string | null;
  text?: string | null;
  webUrl?: string | null;
  meta?: { title?: string | null } | null;
}

/**
 * Maps what the OS shared to a caption and a link, or null when there is nothing to read (a photo
 * or a file was shared, or the text is empty). Media is ignored on purpose: the app never takes a
 * video (R11), and photos come in through the add screen's own picker.
 */
export function toSharedInput(share: IncomingShare, now = Date.now()): SharedInput | null {
  if (share.type === "media" || share.type === "file") return null;
  const raw = (share.text ?? share.webUrl ?? "").trim();
  const split = splitSharedText(raw);
  const url = split.url ?? share.webUrl ?? null;

  // iOS puts the page title in meta; Instagram and TikTok sometimes carry the caption there.
  const title = share.meta?.title?.trim() ?? "";
  const parts = [title, split.text].filter((part) => part.length > 0);
  const text = parts.filter((part, i) => parts.indexOf(part) === i).join("\n");

  if (!text && !url) return null;
  return { text, url, receivedAt: now };
}

let pending: SharedInput | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function setSharedInput(input: SharedInput): void {
  pending = input;
  notify();
}

/** What is waiting, without removing it. The same object until it changes. */
export function peekSharedInput(): SharedInput | null {
  return pending;
}

/** Removes and returns what is waiting. */
export function takeSharedInput(): SharedInput | null {
  const taken = pending;
  pending = null;
  if (taken) notify();
  return taken;
}

export function subscribeSharedInput(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
