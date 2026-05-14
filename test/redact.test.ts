import { describe, expect, it } from "vitest";
import { redact, hasSecret } from "../src/indexer/redact.js";

describe("redact", () => {
  it("masks OpenAI keys", () => {
    const out = redact("here sk-abcdef0123456789ABCDEF foo");
    expect(out).toContain("[REDACTED:openai_key]");
    expect(out).not.toContain("sk-abcdef");
  });

  it("masks Anthropic keys", () => {
    const out = redact("token: sk-ant-api03-aaaaaaaaaaaaaaaaaaaa");
    expect(out).toContain("[REDACTED:anthropic_key]");
  });

  it("masks AWS access keys", () => {
    const out = redact("aws AKIAIOSFODNN7EXAMPLE done");
    expect(out).toContain("[REDACTED:aws_access_key]");
  });

  it("masks GitHub tokens", () => {
    const out = redact("export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).toContain("[REDACTED:github_token]");
  });

  it("masks Bearer tokens", () => {
    const out = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.foo.bar");
    expect(out).toContain("[REDACTED:bearer]");
  });

  it("masks PEM private keys", () => {
    const pem = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEF
ABCDEF
-----END PRIVATE KEY-----`;
    const out = redact("before\n" + pem + "\nafter");
    expect(out).toContain("[REDACTED:pem_block]");
    expect(out).not.toContain("MIIEvQIBADAN");
  });

  it("masks key=value secrets while keeping the key visible", () => {
    const out = redact('password="hunter2supersecret"');
    expect(out).toContain("[REDACTED:kv_secret]");
    expect(out).toContain("password");
  });

  it("hasSecret detects without modifying", () => {
    expect(hasSecret("nothing here")).toBe(false);
    expect(hasSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  it("preserves benign text", () => {
    const before = "Just a normal sentence about tokens and passwords conceptually.";
    expect(redact(before)).toBe(before);
  });
});
