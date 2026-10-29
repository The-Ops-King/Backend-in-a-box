import { commandsDoor } from "@/api/slack-doors";
import { sharedDoor } from "@/api/slack-shared";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** The shared Slack app (D251): the slash commands door; each command answers for the one offer it was sent from. */
export const POST = (req: Request) => sharedDoor(req, commandsDoor);
