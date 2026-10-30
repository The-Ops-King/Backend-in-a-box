/**
 * A video link as it is shared (Google Drive, YouTube, Loom) → the address that plays inside the page. Anything else is
 * not embedded: the page links to it instead, so a pasted link never breaks the page.
 */
export function embedUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./, "");
  if (host === "drive.google.com") {
    const id = /\/file\/d\/([\w-]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get("id");
    return id ? `https://drive.google.com/file/d/${id}/preview` : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com") {
    const id = u.pathname === "/watch" ? u.searchParams.get("v") : /^\/(?:embed|shorts|live)\/([\w-]+)/.exec(u.pathname)?.[1];
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === "youtu.be") { const id = u.pathname.slice(1).split("/")[0]; return id ? `https://www.youtube-nocookie.com/embed/${id}` : null; }
  if (host === "loom.com") { const id = /^\/(?:share|embed)\/([\w-]+)/.exec(u.pathname)?.[1]; return id ? `https://www.loom.com/embed/${id}` : null; }
  return null;
}
