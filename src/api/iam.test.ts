import { describe, expect, it } from "vitest";
import { daysSince, filterPolicies, matchesFilter, policyNameOf, prettyJson, sessionText, trustText, type PolicySummary, type Trust } from "./iam";

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

describe("iam policies", () => {
  const p = (name: string, awsManaged: boolean, attachments = 0, boundaryUses = 0, path = "/"): PolicySummary => ({
    name,
    id: name,
    arn: `arn:aws:iam::${awsManaged ? "aws" : "123456789012"}:policy${path}${name}`,
    path,
    defaultVersion: "v1",
    attachments,
    boundaryUses,
    attachable: true,
    created: null,
    updated: null,
    awsManaged,
  });
  const all = [p("Mine", false, 1), p("Unused", false), p("ReadOnlyAccess", true, 2), p("AWSLambdaRole", true, 0, 0, "/service-role/"), p("Boundary", false, 0, 1)];

  it("filters by scope, attachment and name", () => {
    expect(filterPolicies(all, "customer", false, "").map((x) => x.name)).toEqual(["Mine", "Unused", "Boundary"]);
    expect(filterPolicies(all, "aws", false, "").length).toBe(2);
    expect(filterPolicies(all, "all", true, "").map((x) => x.name)).toEqual(["Mine", "ReadOnlyAccess", "Boundary"]);
    expect(filterPolicies(all, "all", false, "/service-role/").map((x) => x.name)).toEqual(["AWSLambdaRole"]);
    expect(filterPolicies(all, "aws", false, "read").map((x) => x.name)).toEqual(["ReadOnlyAccess"]);
  });

  it("names policies from their ARNs", () => {
    expect(policyNameOf("arn:aws:iam::aws:policy/service-role/AWSLambdaRole")).toBe("AWSLambdaRole");
    expect(policyNameOf("arn:aws:iam::123456789012:policy/Mine")).toBe("Mine");
    expect(policyNameOf("plain")).toBe("plain");
  });
});

describe("prettyJson", () => {
  it("normalises JSON spacing and leaves other text", () => {
    expect(prettyJson('{"a":[1, 2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson("not json")).toBe("not json");
  });
});
