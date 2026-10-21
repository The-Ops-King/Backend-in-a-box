import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** GET /health: the app is up. Railway's health check and the uptime monitor read it. */
export function GET() { return NextResponse.json({ ok: true }); }
