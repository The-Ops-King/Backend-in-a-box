/**
 * D263: the team onboarding page (`/<offer>/onboarding`): how a new closer, setter or manager gets set up and works the
 * offer's systems. Static: the words live here, per offer, and change by editing this folder. Nothing is read from the engine.
 */
export type Role = "closer" | "setter" | "manager";
export const ROLES: { id: Role; label: string; about: string }[] = [
  { id: "closer", label: "Closer", about: "You take the closing calls." },
  { id: "setter", label: "Setter", about: "You take the triage calls and book the closing calls." },
  { id: "manager", label: "Manager", about: "You run the team: everything the closers and setters do, and what only you do." },
];

/** A video: a Google Drive, YouTube or Loom link as you'd copy it from the browser; null until it is recorded. */
export type Video = { title: string; url: string | null };
export type Block =
  | { p: string }
  | { list: string[] }
  | { steps: string[] }
  | { rows: [string, string][]; head?: [string, string] }
  | { note: string; tone?: "tip" | "important" }
  | { video: Video };

/** `for`: the roles the section is for; a manager sees every section. */
export type Section = { id: string; title: string; for: Role[]; summary: string; blocks: Block[] };
export type Part = { id: string; title: string; sections: Section[] };
export type Guide = {
  slug: string;
  brand: { name: string; accent: string; logoUrl?: string };
  title: string;
  intro: string;
  parts: Part[];
};

export const sectionShows = (s: Section, role: Role) => role === "manager" || s.for.includes(role);
