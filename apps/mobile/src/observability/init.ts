// Imported first by app/_layout.tsx so Sentry is listening before any screen renders. A build with
// no EXPO_PUBLIC_SENTRY_DSN does nothing.
import { initSentry } from "./sentry";

initSentry();
