import { asOperator, one } from "@/db/client";
import { teamLinks } from "@/engine/team-links";

/** D283/D314: the offer's booking links, read live; every onboarding page stands without them if the engine cannot be read. */
export const linksFor = (slug: string) => asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); return co ? teamLinks(c, co.id) : null; }).catch(() => null);
