import { describe, it, expect } from "vitest";
import { embedUrl } from "./embed";
import { GUIDES } from "./index";
import { ROLES, sectionShows } from "./types";

describe("D260: the team onboarding page", () => {
  it("plays Drive, YouTube and Loom links inside the page; anything else is only linked", () => {
    expect(embedUrl("https://drive.google.com/file/d/1AbC-d_9/view?usp=sharing")).toBe("https://drive.google.com/file/d/1AbC-d_9/preview");
    expect(embedUrl("https://drive.google.com/open?id=1AbC")).toBe("https://drive.google.com/file/d/1AbC/preview");
    expect(embedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(embedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(embedUrl("https://www.loom.com/share/abc123def")).toBe("https://www.loom.com/embed/abc123def");
    for (const bad of ["http://youtu.be/x", "https://vimeo.com/1", "not a link", "https://drive.google.com/drive/folders/x"]) expect(embedUrl(bad)).toBeNull();
  });

  it("every guide is whole: unique ids, each section for at least one role, every role has something to read", () => {
    for (const g of Object.values(GUIDES)) {
      const ids = g.parts.flatMap((p) => [p.id, ...p.sections.map((s) => s.id)]);
      expect(new Set(ids).size, g.slug).toBe(ids.length);
      for (const s of g.parts.flatMap((p) => p.sections)) expect(s.for.length, s.id).toBeGreaterThan(0);
      for (const r of ROLES) expect(g.parts.flatMap((p) => p.sections).filter((s) => sectionShows(s, r.id)).length, `${g.slug} ${r.id}`).toBeGreaterThan(0);
      expect(g.brand.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
