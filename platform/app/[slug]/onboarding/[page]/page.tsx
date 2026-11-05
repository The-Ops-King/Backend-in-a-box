import { notFound } from "next/navigation";
import { GUIDES } from "@/team-guide";
import { GuideView } from "../guide";
import { linksFor } from "../links";

/** D314: the onboarding guide's pages after the first, at `/<offer>/onboarding/<page id>`. */
export const dynamicParams = false;
export const dynamic = "force-dynamic";
export const generateStaticParams = () => Object.values(GUIDES).flatMap((g) => g.pages.slice(1).map((p) => ({ slug: g.slug, page: p.id })));

export async function generateMetadata({ params }: { params: Promise<{ slug: string; page: string }> }) {
  const { slug, page } = await params, g = GUIDES[slug], p = g?.pages.find((x) => x.id === page);
  return g && p ? { title: `${p.title} · ${g.brand.name}`, description: p.intro, robots: { index: false, follow: false } } : {};
}

export default async function Page({ params }: { params: Promise<{ slug: string; page: string }> }) {
  const { slug, page } = await params, g = GUIDES[slug];
  if (!g || !g.pages.slice(1).some((p) => p.id === page)) notFound();
  return <GuideView guide={g} links={await linksFor(g.slug)} pageId={page} />;
}
