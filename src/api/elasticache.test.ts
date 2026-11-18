import { describe, expect, it } from "vitest";
import { cliCommand, connectionUri, groupTarget, serverlessTarget, ssmTunnelCommand, type Group, type Serverless } from "./elasticache";

const ep = (address: string, port = 6379) => ({ address, port });

function group(over: Partial<Group>): Group {
  return {
    id: "g", arn: null, description: null, status: "available", engine: "valkey", nodeType: "cache.t4g.micro", clusterMode: false,
    shards: [{ id: "0001", status: "available", slots: null, primaryEndpoint: ep("primary.x"), readerEndpoint: ep("reader.x"), members: [{ clusterId: "g-001", nodeId: "0001", role: "primary", az: "a", endpoint: ep("g-001.x") }] }],
    memberCount: 1, automaticFailover: null, multiAz: null, configurationEndpoint: null, transitEncryption: false, transitEncryptionMode: null, atRestEncryption: false,
    kmsKeyId: null, authToken: false, authTokenLastModified: null, userGroupIds: [], snapshotRetention: null, snapshotWindow: null, snapshottingCluster: null,
    dataTiering: null, networkType: null, ipDiscovery: null, autoMinorVersionUpgrade: null, globalDatastore: null, globalDatastoreRole: null, created: null, logDelivery: [], pending: [],
    ...over,
  };
}

describe("connect commands", () => {
  it("cluster mode off, no TLS, no auth: primary first, plain redis://", () => {
    const t = groupTarget(group({}));
    expect(t.endpoints.map((e) => e.label)).toEqual(["Primary endpoint (reads and writes)", "Reader endpoint (reads, spread over replicas)", "Node g-001 (primary)"]);
    expect(cliCommand(t, "primary.x", 6379)).toBe("valkey-cli -h primary.x -p 6379");
    expect(connectionUri(t, t.main!)).toBe("redis://primary.x:6379");
  });

  it("cluster mode on with TLS and an AUTH token: -c, --tls, --askpass, rediss://", () => {
    const t = groupTarget(group({ engine: "redis", clusterMode: true, configurationEndpoint: ep("cfg.x"), transitEncryption: true, transitEncryptionMode: "required", authToken: true }));
    expect(t.main).toEqual(ep("cfg.x"));
    expect(cliCommand(t, "cfg.x", 6379)).toBe("redis-cli -h cfg.x -p 6379 --tls -c --askpass");
    expect(connectionUri(t, t.main!)).toBe("rediss://cfg.x:6379");
    expect(cliCommand(t, "localhost", 6379, { sni: "cfg.x" })).toBe("redis-cli -h localhost -p 6379 --tls --sni cfg.x -c --askpass");
  });

  it("RBAC users ask for a user name; preferred TLS keeps plain URIs working", () => {
    const t = groupTarget(group({ userGroupIds: ["ug"], transitEncryption: true, transitEncryptionMode: "preferred" }));
    expect(cliCommand(t, "h", 6380)).toBe("valkey-cli -h h -p 6380 --tls --user <username> --askpass");
    expect(connectionUri(t, ep("h", 6380))).toBe("redis://<username>@h:6380");
  });

  it("serverless caches always use TLS and the cluster protocol", () => {
    const s = { name: "s", engine: "valkey", endpoint: ep("s.x"), readerEndpoint: ep("s.x", 6380), userGroupId: null } as unknown as Serverless;
    const t = serverlessTarget(s);
    expect(cliCommand(t, "s.x", 6379)).toBe("valkey-cli -h s.x -p 6379 --tls -c");
    expect(connectionUri(t, t.main!)).toBe("rediss://s.x:6379");
  });

  it("builds a Session Manager tunnel", () => {
    expect(ssmTunnelCommand(ep("cfg.x", 6379), "prod", "eu-west-2")).toBe(
      "aws ssm start-session --target <instance-id> --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host=cfg.x,portNumber=6379,localPortNumber=6379 --profile prod --region eu-west-2",
    );
  });
});

describe("snapshot and cache names", () => {
  it("follow AWS's rules", async () => {
    const { snapshotNameProblem, cacheNameProblem } = await import("../services/elasticache/Snapshots");
    expect(snapshotNameProblem("nightly-2026-11-18")).toBeNull();
    expect(snapshotNameProblem("1st")).not.toBeNull();
    expect(snapshotNameProblem("a_b")).not.toBeNull();
    expect(snapshotNameProblem("a--b")).not.toBeNull();
    expect(snapshotNameProblem("end-")).not.toBeNull();
    expect(cacheNameProblem("orders-restored")).toBeNull();
    expect(cacheNameProblem("a".repeat(41))).not.toBeNull();
    expect(cacheNameProblem("9lives")).not.toBeNull();
  });
});
