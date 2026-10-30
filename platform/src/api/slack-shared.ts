import { NextResponse } from "next/server";
import { sharedSlackApp, type SharedApp } from "@/engine/slack-app";

/** D251: a shared-app door answers only once the server has the app's three keys; until then Slack is told why. */
export function sharedDoor(req: Request, door: (req: Request, key: { shared: SharedApp }) => Promise<Response>): Promise<Response> {
  const app = sharedSlackApp();
  if (!app) return Promise.resolve(NextResponse.json({ error: "the shared Slack app is not set up on this server (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET)" }, { status: 503 }));
  return door(req, { shared: app });
}
