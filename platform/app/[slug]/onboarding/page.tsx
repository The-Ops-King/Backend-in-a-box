import { notFound } from "next/navigation";
import { GUIDES } from "@/team-guide";
import { GuideView } from "./guide";

/** D263: the team onboarding page, one per offer, built at deploy from `src/team-guide`; an offer without one is a 404. */
export const dynamicParams = false;
export const generateStaticParams = () => Object.keys(GUIDES).map((slug) => ({ slug }));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const g = GUIDES[(await params).slug];
  return g ? { title: `${g.title} · ${g.brand.name}`, description: g.intro, robots: { index: false, follow: false } } : {};
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const g = GUIDES[(await params).slug];
  if (!g) notFound();
  return <GuideView guide={g} />;
}
