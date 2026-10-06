import type { Adapters } from "./types";
import { ghlRead } from "./ghl/read";
import { ghlWrite } from "./ghl/write";
import { ghlSender } from "./ghl/sender";
import { jevClassifier } from "./jev/classifier";
import { slackNotifier } from "./slack/notifier";
export const liveAdapters: Adapters = { read: ghlRead, write: ghlWrite, sender: ghlSender, classifier: jevClassifier, notifier: slackNotifier };
