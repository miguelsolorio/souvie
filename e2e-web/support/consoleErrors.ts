import type { Page } from "@playwright/test";

/**
 * Collects what a page logs as an error: console.error calls, uncaught exceptions, and failed
 * requests for the app's own files. Call before `page.goto`. `errors()` is read at the end of the
 * test, so a late error still fails it.
 */
export function watchConsoleErrors(page: Page, options: { ignore?: RegExp[] } = {}) {
  const found: string[] = [];
  const ignore = options.ignore ?? [];
  const keep = (text: string) => !ignore.some((pattern) => pattern.test(text));

  page.on("console", (message) => {
    if (message.type() === "error" && keep(message.text())) {
      found.push(`console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    if (keep(error.message)) found.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.hostname === "127.0.0.1" && keep(request.url())) {
      found.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ""}`);
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.hostname === "127.0.0.1" && url.port === new URL(page.url() || "http://x").port) {
      if (response.status() >= 400 && keep(response.url())) {
        found.push(`http ${response.status()}: ${response.url()}`);
      }
    }
  });

  return { errors: () => [...found] };
}
