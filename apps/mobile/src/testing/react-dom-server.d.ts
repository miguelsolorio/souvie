// react-dom ships no types and @types/react-dom is not installed. Screen tests need exactly one
// function from it, so this declares just that.
declare module "react-dom/server" {
  import type { ReactNode } from "react";

  export function renderToStaticMarkup(node: ReactNode): string;
}
