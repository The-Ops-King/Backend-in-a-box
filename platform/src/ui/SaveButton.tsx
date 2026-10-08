"use client";
import { useFormStatus } from "react-dom";

/** A submit button that says what it is doing: the request runs in the background and the page updates in place, so the button is the only cue. */
export function SaveButton({ children, className = "btn btn-on", pendingLabel = "Saving…" }: { children: React.ReactNode; className?: string; pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return <button className={className} type="submit" disabled={pending} aria-busy={pending} style={pending ? { opacity: 0.7, cursor: "progress" } : undefined}>{pending ? pendingLabel : children}</button>;
}
