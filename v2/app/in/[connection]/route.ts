import { door } from "@/connectors/doors";
import { defaultHub } from "@/connectors/runtime";

export const dynamic = "force-dynamic";

/** POST /in/{connection}: the generic signed door (Zapier, Make, any tool): Standard Webhooks with the connection's own secret (src/connectors/doors.ts). */
export async function POST(req: Request, { params }: { params: Promise<{ connection: string }> }) {
  return door(defaultHub(), "generic", (await params).connection, req);
}
