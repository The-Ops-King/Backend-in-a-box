import { describe, it, expect } from "vitest";
import { normalizeDatabaseUrl } from "./client";
describe("normalizeDatabaseUrl", () => {
  const sess = "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
  it("moves a Supabase session-mode pooler URL to transaction mode", () => {
    expect(normalizeDatabaseUrl(sess, {})).toBe("postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
  });
  it("leaves transaction mode, direct connections and other hosts alone", () => {
    expect(normalizeDatabaseUrl(sess.replace("5432", "6543"), {})).toBe(sess.replace("5432", "6543"));
    expect(normalizeDatabaseUrl("postgresql://postgres:pw@db.abc.supabase.co:5432/postgres", {})).toBe("postgresql://postgres:pw@db.abc.supabase.co:5432/postgres");
    expect(normalizeDatabaseUrl("postgres://tyler@/model?host=/tmp&port=5499", {})).toBe("postgres://tyler@/model?host=/tmp&port=5499");
  });
  it("DB_POOLER_MODE=session opts out", () => { expect(normalizeDatabaseUrl(sess, { DB_POOLER_MODE: "session" })).toBe(sess); });
});
