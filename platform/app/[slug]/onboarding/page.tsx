import { notFound } from "next/navigation";
import { GUIDES } from "@/team-guide";
import { GuideView } from "./guide";
import { asOperator, one } from "@/db/client";
import { teamLinks } from "@/engine/team-links";

/** D263: the team onboarding page, one per offer, built at deploy from `src/team-guide`; an offer without one is a 404. */
export const dynamicParams = false;
// D283: the links are read live (the roster and the offer's team.links), so a new setter shows without a deploy
export const dynamic = "force-dynamic";
export const generateStaticParams = () => Object.keys(GUIDES).map((slug) => ({ slug }));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const g = GUIDES[(await params).slug];
  return g ? { title: `${g.title} · ${g.brand.name}`, description: g.intro, robots: { index: false, follow: false } } : {};
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const g = GUIDES[(await params).slug];
  if (!g) notFound();
  // the page stands without the links if the engine cannot be read
  const links = await asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [g.slug]); return co ? teamLinks(c, co.id) : null; }).catch(() => null);
  return <GuideView guide={g} links={links} />;
}
