import { eventsDoor } from "@/api/slack-doors";
import { sharedDoor } from "@/api/slack-shared";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** The shared Slack app (D251): the events door for every workspace it is installed in; the offer is found from the request. */
export const POST = (req: Request) => sharedDoor(req, eventsDoor);
