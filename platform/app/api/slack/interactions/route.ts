import { interactionsDoor } from "@/api/slack-doors";
import { sharedDoor } from "@/api/slack-shared";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** The shared Slack app (D251): the interactivity door (buttons and forms). */
export const POST = (req: Request) => sharedDoor(req, interactionsDoor);
