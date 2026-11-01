import type { Page } from "@playwright/test";

/** The port the static server listens on (playwright.config.ts). */
const APP_PORT = String(process.env.E2E_PORT ?? 4173);

/**
 * Collects what a page logs as an error: console.error calls, uncaught exceptions, and failed or
 * 4xx and 5xx requests for the app's own files. Call before `page.goto`. `errors()` is read at the
 * end of the test, so a late error still fails it.
 *
 * Calls to the fake Supabase (a different port) are not judged here: an answer such as "no rows"
 * is part of how the app talks to it, and the specs check those through `fake.unhandled`.
 */
export function watchConsoleErrors(page: Page, options: { ignore?: RegExp[] } = {}) {
  const found: string[] = [];
  const ignore = options.ignore ?? [];
  const keep = (text: string) => !ignore.some((pattern) => pattern.test(text));
  const isApp = (address: string) => {
    const url = new URL(address);
    return url.hostname === "127.0.0.1" && url.port === APP_PORT;
  };

  page.on("console", (message) => {
    if (message.type() === "error" && keep(message.text())) {
      found.push(`console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    if (keep(error.message)) found.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    if (isApp(request.url()) && keep(request.url())) {
      found.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ""}`);
    }
  });
  page.on("response", (response) => {
    if (isApp(response.url()) && response.status() >= 400 && keep(response.url())) {
      found.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  return { errors: () => [...found] };
}
