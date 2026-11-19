import { describe, expect, it } from "vitest";
import { allowedActions, instanceLabel, isOpenToWorld, matchesInstanceFilter, ruleSource, typeText, type Rule } from "./ec2";

const inst = { id: "i-0abc123", name: "Web Server", tags: [["Name", "Web Server"], ["env", "Prod"]] as [string, string][] };

describe("matchesInstanceFilter", () => {
  it("matches id prefixes and name parts, ignoring case", () => {
    expect(matchesInstanceFilter(inst, "")).toBe(true);
    expect(matchesInstanceFilter(inst, "i-0ab")).toBe(true);
    expect(matchesInstanceFilter(inst, "0abc")).toBe(false);
    expect(matchesInstanceFilter(inst, "server")).toBe(true);
    expect(matchesInstanceFilter(inst, "db")).toBe(false);
  });
  it("matches tags as key=value prefix", () => {
    expect(matchesInstanceFilter(inst, "env=prod")).toBe(true);
    expect(matchesInstanceFilter(inst, "ENV=pr")).toBe(true);
    expect(matchesInstanceFilter(inst, "env=")).toBe(true);
    expect(matchesInstanceFilter(inst, "env=dev")).toBe(false);
    expect(matchesInstanceFilter(inst, "team=")).toBe(false);
  });
  it("treats a leading = as text", () => {
    expect(matchesInstanceFilter({ ...inst, name: "a=b" }, "=b")).toBe(true);
  });
});

describe("labels", () => {
  it("labels instances", () => {
    expect(instanceLabel(inst)).toBe("Web Server (i-0abc123)");
    expect(instanceLabel({ id: "i-1", name: null })).toBe("i-1");
  });
  it("describes rule sources", () => {
    const r: Rule = { protocol: "TCP", ports: "22", sourceKind: "group", source: "sg-1", sourceName: "bastion", sourceAccount: null, description: null };
    expect(ruleSource(r)).toBe("bastion (sg-1)");
    expect(ruleSource({ ...r, sourceAccount: "222" })).toBe("bastion (sg-1) · account 222");
    expect(ruleSource({ ...r, sourceKind: "cidr", source: "10.0.0.0/8" })).toBe("10.0.0.0/8");
    expect(isOpenToWorld({ ...r, sourceKind: "cidr", source: "0.0.0.0/0" })).toBe(true);
  });
});

describe("actions", () => {
  it("allows actions by state", () => {
    expect(allowedActions(["running"])).toEqual({ start: false, stop: true, reboot: true, terminate: true });
    expect(allowedActions(["stopped", "running"])).toEqual({ start: false, stop: false, reboot: false, terminate: true });
    expect(allowedActions(["terminated"]).terminate).toBe(false);
    expect(allowedActions([]).start).toBe(false);
  });
  it("describes instance types", () => {
    expect(typeText({ name: "t3.small", vcpus: 2, memoryMib: 2048, currentGeneration: true })).toBe("t3.small · 2 vCPUs · 2 GiB");
    expect(typeText({ name: "t3.nano", vcpus: 1, memoryMib: 512, currentGeneration: true })).toBe("t3.nano · 1 vCPU · 0.5 GiB");
    expect(typeText({ name: "x.y", vcpus: null, memoryMib: null, currentGeneration: null })).toBe("x.y");
  });
});
