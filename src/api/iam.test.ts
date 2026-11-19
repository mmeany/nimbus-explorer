import { describe, expect, it } from "vitest";
import { accountOf, daysSince, filterPolicies, pickerRoles, roleLinkName, type RoleSummary, groupFindings, highlightSegments, type Finding, parseActions, splitList, statementRange, limitRows, quotaRows, unusedCredentials, type CredentialRow, type KeyCredential, matchesFilter, policyNameOf, prettyJson, sessionText, trustText, type PolicySummary, type Trust } from "./iam";

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

describe("iam account", () => {
  it("pairs usage with quotas and lists the other limits", () => {
    const s: [string, number][] = [["AccessKeysPerUserQuota", 2], ["Groups", 2], ["GroupsQuota", 300], ["MFADevices", 0], ["Users", 3], ["UsersQuota", 5000]];
    expect(quotaRows(s)).toEqual([["Users", 3, 5000], ["User groups", 2, 300]]);
    expect(limitRows(s)).toEqual([["Access keys per user", 2]]);
  });

  it("finds unused and old credentials", () => {
    const now = Date.parse("2026-11-19T00:00:00Z");
    const row = (over: Partial<CredentialRow>): CredentialRow => ({ user: "u", arn: "", created: "2026-01-01T00:00:00Z", passwordEnabled: false, passwordLastUsed: null, passwordLastChanged: null, passwordNextRotation: null, mfaActive: false, keys: [], certificatesActive: 0, ...over });
    const key = (slot: number, active: boolean, lastRotated: string, lastUsed: string | null): KeyCredential => ({ slot, active, lastRotated, lastUsed, lastRegion: null, lastService: null });
    const f = unusedCredentials(
      [
        row({ user: "fresh", passwordEnabled: true, passwordLastUsed: "2026-11-18T00:00:00Z", keys: [key(1, true, "2026-11-01T00:00:00Z", "2026-11-18T00:00:00Z")] }),
        row({ user: "idle", passwordEnabled: true, passwordLastUsed: "2026-01-01T00:00:00Z" }),
        row({ user: "never", passwordEnabled: true, keys: [key(1, true, "2026-11-09T00:00:00Z", null), key(2, false, "2020-01-01T00:00:00Z", null)] }),
        row({ user: "old", keys: [key(1, true, "2025-01-01T00:00:00Z", "2026-11-18T00:00:00Z")] }),
        row({ user: "<root_account>", passwordEnabled: null }),
      ],
      90,
      90,
      now,
    );
    expect(f.map((x) => `${x.user}:${x.credential}:${x.kind}`)).toEqual(["idle:Console password:unused", "never:Console password:never", "never:Access key 1:never", "old:Access key 1:old"]);
    expect(f[0].issue).toBe("Not used for 322 days");
    expect(f[2].days).toBe(10);
  });
});

describe("iam simulator", () => {
  it("parses action lists", () => {
    expect(parseActions("s3:GetObject, s3:PutObject\n s3:GetObject")).toEqual({ actions: ["s3:GetObject", "s3:PutObject"], error: null });
    expect(parseActions("s3:Get*").error).toMatch(/wildcards/);
    expect(parseActions("GetObject").error).toMatch(/service:Action/);
    expect(splitList(" a\n\nb , c ")).toEqual(["a", "b", "c"]);
  });

  it("finds a statement by line and column", () => {
    const doc = '{\n  "Statement": [\n    {"Effect": "Allow"}\n  ]\n}';
    expect(statementRange(doc, [3, 5], [3, 23])).toEqual(['{\n  "Statement": [\n    ', '{"Effect": "Allow"}', "\n  ]\n}"]);
    expect(statementRange(doc, [9, 1], [9, 2])).toBeNull();
    expect(statementRange(doc, null, [1, 1])).toBeNull();
  });
});

describe("policy validation", () => {
  const f = (severity: string, start: number, end: number): Finding => ({ severity, issueCode: "X", details: "", learnMore: "", locations: [{ path: "", start, end, line: 1, column: start }] });

  it("groups findings by severity", () => {
    const g = groupFindings([f("SUGGESTION", 0, 1), f("ERROR", 0, 1), f("SUGGESTION", 2, 3)]);
    expect(g.map((x) => [x.severity, x.items.map((i) => i.index)])).toEqual([["ERROR", [1]], ["SUGGESTION", [0, 2]]]);
  });

  it("marks the document by location", () => {
    const s = highlightSegments("abcdefgh", [f("WARNING", 1, 5), f("ERROR", 3, 4)], 0);
    expect(s).toEqual([
      { text: "a", severity: null, selected: false },
      { text: "bc", severity: "WARNING", selected: true },
      { text: "d", severity: "ERROR", selected: true },
      { text: "e", severity: "WARNING", selected: true },
      { text: "fgh", severity: null, selected: false },
    ]);
    expect(highlightSegments("ab", [f("ERROR", 5, 9)], null)).toEqual([{ text: "ab", severity: null, selected: false }]);
  });
});

describe("role links and picker", () => {
  it("links roles of the resource's account", () => {
    const fn = "arn:aws:lambda:eu-west-2:123456789012:function:f";
    expect(roleLinkName("arn:aws:iam::123456789012:role/service-role/my-role", fn)).toBe("my-role");
    expect(roleLinkName("arn:aws:iam::999999999999:role/my-role", fn)).toBeNull();
    expect(roleLinkName("arn:aws:iam::123456789012:user/u", fn)).toBeNull();
    expect(roleLinkName(null, fn)).toBeNull();
    expect(roleLinkName("arn:aws:iam::123456789012:role/r", null)).toBeNull();
    expect(accountOf("arn:aws:states:us-east-1:000000000000:stateMachine:m")).toBe("000000000000");
  });

  it("puts roles trusting the service first", () => {
    const r = (name: string, trustedServices: string[], serviceLinked = false): RoleSummary => ({ name, id: name, arn: `arn:aws:iam::1:role/${name}`, path: "/", created: null, description: null, maxSessionSecs: null, serviceLinked, trustedServices });
    const roles = [r("a", ["states.amazonaws.com"]), r("b", ["lambda.amazonaws.com"]), r("c", []), r("AWSServiceRoleForX", ["states.amazonaws.com"], true)];
    expect(pickerRoles(roles, "states.amazonaws.com", false, "")).toEqual({ trusting: [roles[0]], others: [] });
    expect(pickerRoles(roles, "states.amazonaws.com", true, "").others.map((x) => x.name)).toEqual(["b", "c"]);
    expect(pickerRoles(roles, "states.amazonaws.com", true, "B").others.map((x) => x.name)).toEqual(["b"]);
  });
});
