export function operatorAuthorized(req: Request): boolean {
  const s = process.env.CRON_SECRET;
  return !!s && req.headers.get("authorization") === `Bearer ${s}`;
}
