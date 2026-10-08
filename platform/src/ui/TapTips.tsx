"use client";
import { useEffect } from "react";

/** On a phone there is no hover: a tap on an outline line opens its popover, a tap anywhere else (or on it again) closes it. */
export function TapTips() {
  useEffect(() => {
    const onTap = (e: Event) => {
      const t = e.target as HTMLElement | null; if (!t) return;
      if (t.closest("a, button, input, select, textarea, label, form")) return;   // real controls keep working
      const row = t.closest<HTMLElement>(".ol-row.has-tip"); const inTip = t.closest(".ol-tip");
      if (inTip) return;   // tapping inside the popover (to scroll it) keeps it open
      document.querySelectorAll(".ol-row.open").forEach((el) => { if (el !== row) el.classList.remove("open"); });
      if (row) { row.classList.toggle("open"); e.preventDefault(); }
    };
    document.addEventListener("click", onTap);
    return () => document.removeEventListener("click", onTap);
  }, []);
  return null;
}
