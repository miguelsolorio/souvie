import type { ReactNode } from "react";

/** The phone has no main landmark, so the tree is exactly what it was. See MainLandmark.tsx. */
export function MainLandmark({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
