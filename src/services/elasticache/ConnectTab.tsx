// Connect tab: how to reach a cache from your own machine or code. Endpoints,
// TLS and authentication, CLI commands and URIs to copy, and how to get into
// the VPC. Passwords and AUTH tokens are never shown (AWS doesn't return them).
import { cliCommand, cliFor, connectionUri, endpointText, ssmTunnelCommand, type ConnectTarget } from "../../api/elasticache";
import type { Shell } from "../../shell/shell";
import { PropsTable } from "./CacheViews";

function Copyable({ text, shell }: { text: string; shell: Shell }) {
  return (
    <div className="row sfn-cmd">
      <code className="mono selectable">{text}</code>
      <button className="link-btn" onClick={() => void shell.copyText(text)}>
        Copy
      </button>
    </div>
  );
}

export function ConnectTab({ shell, t }: { shell: Shell; t: ConnectTarget }) {
  const region = shell.connection?.serviceRegion ?? "";
  const emulator = !!shell.connection?.endpointUrl;
  const main = t.main;
  const cli = cliFor(t.engine);
  if (!main) return <p className="hint">This cache has no endpoint yet (it may still be creating).</p>;
  const port = main.port ?? 6379;
  return (
    <div className="lambda-details">
      <div className="props-section">Endpoints</div>
      <table className="sync-table">
        <tbody>
          {t.endpoints.map((e) => (
            <tr key={`${e.label}|${endpointText(e.endpoint)}`}>
              <td>{e.label}</td>
              <td className="mono selectable">{endpointText(e.endpoint)}</td>
              <td className="right">
                <button className="link-btn" onClick={() => void shell.copyText(endpointText(e.endpoint))}>
                  Copy
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="props-section">Connection</div>
      <PropsTable
        rows={[
          ["Encryption in transit", t.tls ? (t.tlsOptional ? "TLS preferred (plain connections still accepted)" : "TLS required") : "None (plain TCP)"],
          [
            "Authentication",
            t.auth === "rbac"
              ? "Users (RBAC): a user name and its password, or an IAM authentication token for users set up for IAM"
              : t.auth === "token"
                ? "AUTH token: one password for every client (AWS never returns it; ask whoever set it up)"
                : "None: anyone who can reach the endpoint can connect",
          ],
          ["Cluster mode", t.cluster ? "Yes: clients must follow MOVED redirects (cluster-aware clients, or -c on the CLI)" : "No"],
        ]}
      />

      <div className="props-section">From the command line</div>
      <Copyable text={cliCommand(t, main.address, port)} shell={shell} />
      <p className="hint">
        {cli} comes with {t.engine === "valkey" ? "Valkey (redis-cli works too)" : "Redis"}.{" "}
        {t.auth !== "none" ? "--askpass prompts for the password, so it doesn't end up in your shell history." : ""} Then try <span className="mono">PING</span> or{" "}
        <span className="mono">INFO server</span>.
      </p>

      <div className="props-section">From code</div>
      <Copyable text={connectionUri(t, main)} shell={shell} />
      <p className="hint">
        {t.cluster ? "Use your client's cluster mode (for example RedisCluster / cluster: true) with this endpoint. " : ""}
        {t.auth !== "none" ? "Pass the password through the client's password option or your secrets store, not in the URI." : ""}
      </p>

      <div className="props-section">Reaching it</div>
      {emulator ? (
        <p className="hint">This connection uses a custom endpoint (an emulator), whose caches are usually reachable from this computer directly.</p>
      ) : (
        <>
          <p className="hint">
            ElastiCache endpoints are private to their VPC: connect from inside it (an EC2 instance, a container, a Lambda function in the VPC), over a VPN or Direct Connect, or through a tunnel. With Session
            Manager port forwarding through any instance in the VPC that can reach the cache:
          </p>
          <Copyable text={ssmTunnelCommand(main, shell.profile, region)} shell={shell} />
          <p className="hint">then, in another terminal, connect to localhost{t.tls ? " (with --sni so TLS checks the right name)" : ""}:</p>
          <Copyable text={cliCommand(t, "localhost", port, { sni: main.address })} shell={shell} />
          {t.cluster && <p className="hint">In cluster mode the CLI is redirected to each node's own address, which a single tunnel doesn't cover: for cluster-mode caches, connect from inside the VPC instead.</p>}
        </>
      )}
    </div>
  );
}
