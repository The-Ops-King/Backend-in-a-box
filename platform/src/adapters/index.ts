import type { Adapters } from "./types";
import { ghlBooking, ghlRead } from "./ghl/read";
import { calendlyBooking } from "./calendly/read";
import { ghlWrite } from "./ghl/write";
import { ghlSender } from "./ghl/sender";
import { jevClassifier } from "./jev/classifier";
import { slackNotifier } from "./slack/notifier";
import { anthropicAnalyst } from "./anthropic/analyst";
export const liveAdapters: Adapters = { read: ghlRead, booking: { ghl: ghlBooking, calendly: calendlyBooking }, write: ghlWrite, sender: ghlSender, classifier: jevClassifier, notifier: slackNotifier, analyst: anthropicAnalyst };
