import { door } from "@/connectors/doors";
import { defaultHub } from "@/connectors/runtime";

export const dynamic = "force-dynamic";

/** POST /in/typeform/{connection}: the connection's signature checked over the raw body, kept once, answered at once (src/connectors/doors.ts). */
export async function POST(req: Request, { params }: { params: Promise<{ connection: string }> }) {
  return door(defaultHub(), "typeform", (await params).connection, req);
}
