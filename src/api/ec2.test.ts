import { describe, expect, it } from "vitest";
import { allowedActions, connectCommands, guessUser, instanceLabel, interfaceOwner, kindOfId, tagProblem, isOpenToWorld, matchesInstanceFilter, ruleSource, typeText, type Rule } from "./ec2";

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

describe("tags", () => {
  it("checks tags like AWS", () => {
    expect(tagProblem([["Name", "web"], ["env", ""]])).toBeNull();
    expect(tagProblem([["", "x"]])).not.toBeNull();
    expect(tagProblem([["aws:x", "1"]])).toContain("reserved");
    expect(tagProblem([["a", "1"], ["a", "2"]])).toContain("twice");
  });
  it("maps ids to kinds", () => {
    expect(kindOfId("i-0abc")).toBe("instances");
    expect(kindOfId("vol-1")).toBe("volumes");
    expect(kindOfId("eipalloc-1")).toBe("addresses");
    expect(kindOfId("weird")).toBeNull();
  });
});

describe("connect", () => {
  const linux = { id: "i-1", keyName: "dev", publicIp: "1.2.3.4", publicDns: "ec2-1.example", privateIp: "10.0.0.1", windows: false, platform: "Linux/UNIX" };
  it("builds Linux commands", () => {
    const c = connectCommands(linux, "dev", "eu-west-2");
    expect(c.map((x) => x.id)).toEqual(["ssm-shell", "ssm-ssh", "ssm-forward", "ssh", "eic"]);
    expect(c[0].command).toBe("aws ssm start-session --target i-1 --profile dev --region eu-west-2");
    expect(c[3].command).toBe("ssh -i ~/.ssh/dev.pem ec2-user@ec2-1.example");
    expect(c[1].command).toContain('ProxyCommand="aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --profile dev --region eu-west-2" ec2-user@i-1');
  });
  it("drops internet commands for private instances and uses an endpoint for Instance Connect", () => {
    const c = connectCommands({ ...linux, publicIp: null, publicDns: null, keyName: null }, null, "us-east-1");
    expect(c.map((x) => x.id)).toEqual(["ssm-shell", "ssm-ssh", "ssm-forward", "eic"]);
    expect(c[3].command).toBe("aws ec2-instance-connect ssh --instance-id i-1 --os-user ec2-user --connection-type eice --region us-east-1");
    expect(c[1].command.startsWith("ssh -o ProxyCommand")).toBe(true);
  });
  it("builds Windows commands", () => {
    const c = connectCommands({ ...linux, windows: true, platform: "Windows" }, "dev", "eu-west-2", "http://localhost:4566");
    expect(c.map((x) => x.id)).toEqual(["ssm-shell", "ssm-rdp", "rdp"]);
    expect(c[0].command).toContain("--endpoint-url http://localhost:4566");
    expect(guessUser({ platform: "Ubuntu Pro", windows: false })).toBe("ubuntu");
  });
});

describe("interfaceOwner", () => {
  const n = { instanceId: null, interfaceType: "interface", requester: null, description: null };
  it("names the owner", () => {
    expect(interfaceOwner({ ...n, instanceId: "i-1" })).toBe("i-1");
    expect(interfaceOwner({ ...n, interfaceType: "nat_gateway" })).toBe("nat gateway");
    expect(interfaceOwner({ ...n, description: "ELB app/web/123" })).toBe("load balancer");
    expect(interfaceOwner({ ...n, description: "AWS Lambda VPC ENI-fn" })).toBe("Lambda");
    expect(interfaceOwner({ ...n, requester: "amazon-rds" })).toBe("amazon-rds");
    expect(interfaceOwner(n)).toBe("");
  });
});
