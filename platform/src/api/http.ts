import { NextResponse } from "next/server";

export const ok = (data: unknown, init?: ResponseInit) => NextResponse.json(data, init);
export const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });
export const readJson = async <T>(req: Request): Promise<T | null> => (await req.json().catch(() => null)) as T | null;
export const dynamic = "force-dynamic";
