import type { Guide } from "./types";
import { datingNelly } from "./dating-nelly";

/** D260: each offer with a team onboarding page, by its slug (the page is `/<slug>/onboarding`). */
export const GUIDES: Record<string, Guide> = { [datingNelly.slug]: datingNelly };
