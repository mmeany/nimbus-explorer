import { describe, expect, it } from "vitest";
import { daysSince, matchesFilter, sessionText, trustText, type Trust } from "./iam";

const t = (kind: string, principal: string): Trust => ({ effect: "Allow", kind, principal, actions: ["sts:AssumeRole"], conditions: false, sid: null });

describe("iam helpers", () => {
  it("filters by name prefix or path", () => {
    const p = { name: "Deploy-Bot", path: "/ci/bots/" };
    expect(matchesFilter(p, "")).toBe(true);
    expect(matchesFilter(p, "deploy")).toBe(true);
    expect(matchesFilter(p, "bot")).toBe(false);
    expect(matchesFilter(p, "/ci/")).toBe(true);
    expect(matchesFilter(p, "/admins/")).toBe(false);
  });

  it("describes session lengths", () => {
    expect(sessionText(3600)).toBe("1 hour");
    expect(sessionText(43200)).toBe("12 hours");
    expect(sessionText(5400)).toBe("90 minutes");
    expect(sessionText(null)).toBe("");
  });

  it("describes trusted principals", () => {
    expect(trustText(t("Service", "lambda.amazonaws.com"))).toBe("Service lambda.amazonaws.com");
    expect(trustText(t("AWS", "arn:aws:iam::123456789012:root"))).toMatch(/^Account 123456789012/);
    expect(trustText(t("AWS", "123456789012"))).toMatch(/^Account 123456789012/);
    expect(trustText(t("AWS", "arn:aws:iam::123456789012:role/x"))).toBe("arn:aws:iam::123456789012:role/x");
    expect(trustText(t("*", "*"))).toMatch(/^Anyone/);
    expect(trustText(t("AWS", "*"))).toMatch(/^Anyone/);
    expect(trustText(t("Federated", "*"))).toBe("Any Federated principal");
  });

  it("counts days since a date", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    expect(daysSince("2026-11-09T12:00:00Z", now)).toBe(10);
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince("junk", now)).toBeNull();
  });
});
