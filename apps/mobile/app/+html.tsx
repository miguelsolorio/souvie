// The HTML shell of the static web export (WS13). It runs only at export time, in Node, so it
// uses no browser API. It sets what every page needs before any script loads: the document
// title, the language, the theme color, and a visible keyboard focus ring.
//
// A custom +html file replaces expo-router's default shell, so it repeats what that shell does:
// `ScrollViewStyleReset` (the `html, body, #root { height: 100% }` reset) and the server
// document context. The context carries the export's scripts, stylesheets, preloads and favicon
// as `headNodes` and `bodyNodes`; leave them out and the page ships with no JavaScript.
import { tokens } from "@mp/ui";
import { ScrollViewStyleReset, useServerDocumentContext } from "expo-router/html";
import type { PropsWithChildren } from "react";
import { DOCUMENT_DESCRIPTION, DOCUMENT_TITLE, focusRingCss } from "../src/lib/webShell";

export default function Root({ children }: PropsWithChildren) {
  const { bodyAttributes, bodyNodes, htmlAttributes, headNodes } = useServerDocumentContext();
  return (
    <html lang="en" {...htmlAttributes}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <title>{DOCUMENT_TITLE}</title>
        <meta name="description" content={DOCUMENT_DESCRIPTION} />
        <meta name="theme-color" content={tokens.color.scale.primary[600]} />
        {/* The app's screens are light only (packages/ui/src/primitives/theme.ts). */}
        <meta name="color-scheme" content="light" />
        <ScrollViewStyleReset />
        {/* Plain text child: the CSS has no characters React would escape. */}
        <style id="mp-focus-ring">{focusRingCss()}</style>
        {headNodes}
      </head>
      <body {...bodyAttributes}>
        {children}
        {bodyNodes}
      </body>
    </html>
  );
}
