// The "Connect" tab: endpoints, user, where the password lives, and ready-made
// client commands / JDBC URLs for the database's engine.
import { engineFamily, type EngineFamily } from "../../api/rds";
import type { Shell } from "../../shell/shell";
import type { Db } from "./DbView";

const DEFAULT_DB: Record<EngineFamily, string> = { postgres: "postgres", mysql: "", sqlserver: "", oracle: "ORCL", db2: "", other: "" };

/** Name of a Secrets Manager secret from its ARN (drops the random suffix). */
export function secretName(arn: string): string {
  const name = arn.split(":secret:")[1] ?? arn;
  return name.replace(/-[A-Za-z0-9]{6}$/, "");
}

interface Snippet {
  label: string;
  text: string;
}

/** Client commands and URLs for one endpoint. */
export function snippets(family: EngineFamily, engine: string, host: string, port: number, user: string, db: string): Snippet[] {
  const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  switch (family) {
    case "postgres":
      return [
        { label: "psql", text: `psql "host=${host} port=${port} dbname=${db || "postgres"} user=${user} sslmode=require"` },
        { label: "JDBC URL", text: `jdbc:postgresql://${host}:${port}/${db || "postgres"}?sslmode=require` },
        { label: "Connection URI", text: `postgresql://${encodeURIComponent(user)}@${host}:${port}/${db || "postgres"}?sslmode=require` },
      ];
    case "mysql": {
      const maria = engine.startsWith("mariadb");
      return [
        { label: maria ? "mariadb" : "mysql", text: `${maria ? "mariadb" : "mysql"} -h ${host} -P ${port} -u ${q(user)} -p ${maria ? "--ssl" : "--ssl-mode=REQUIRED"}${db ? ` ${db}` : ""}` },
        { label: "JDBC URL", text: maria ? `jdbc:mariadb://${host}:${port}/${db}?sslMode=verify-ca` : `jdbc:mysql://${host}:${port}/${db}?sslMode=REQUIRED` },
        { label: "Connection URI", text: `mysql://${encodeURIComponent(user)}@${host}:${port}/${db}` },
      ];
    }
    case "sqlserver":
      return [
        { label: "sqlcmd", text: `sqlcmd -S tcp:${host},${port} -U ${q(user)} -N${db ? ` -d ${db}` : ""}` },
        { label: "JDBC URL", text: `jdbc:sqlserver://${host}:${port};${db ? `databaseName=${db};` : ""}encrypt=true` },
      ];
    case "oracle":
      return [
        { label: "SQL*Plus", text: `sqlplus ${user}@//${host}:${port}/${db || "ORCL"}` },
        { label: "JDBC URL", text: `jdbc:oracle:thin:@//${host}:${port}/${db || "ORCL"}` },
      ];
    case "db2":
      return [{ label: "JDBC URL", text: `jdbc:db2://${host}:${port}/${db || "RDSADMIN"}:sslConnection=true;` }];
    default:
      return [{ label: "Host and port", text: `${host}:${port}` }];
  }
}

function CopyRow({ shell, label, text }: { shell: Shell; label: string; text: string }) {
  return (
    <tr>
      <th>{label}</th>
      <td className="mono selectable">{text}</td>
      <td className="copy-cell">
        <button className="link-btn" onClick={() => void shell.copyText(text)}>
          Copy
        </button>
      </td>
    </tr>
  );
}

export function ConnectTab({ shell, db }: { shell: Shell; db: Db }) {
  const d = db.db;
  const family = engineFamily(d.engine);
  const user = d.masterUsername ?? "admin";
  const database = (db.kind === "cluster" ? db.db.databaseName : db.db.dbName) ?? DEFAULT_DB[family];
  const port = d.port ?? 0;
  const region = shell.connection?.serviceRegion ?? "";
  const profile = shell.connection?.profile;
  const endpoints: { label: string; host: string }[] =
    db.kind === "cluster"
      ? [
          ...(db.db.endpoint ? [{ label: "Writer (cluster endpoint)", host: db.db.endpoint }] : []),
          ...(db.db.readerEndpoint && db.db.members.length > 1 ? [{ label: "Reader endpoint", host: db.db.readerEndpoint }] : []),
        ]
      : db.db.endpoint
        ? [{ label: db.db.readReplicaOf ? "Endpoint (read replica)" : "Endpoint", host: db.db.endpoint }]
        : [];
  const main = endpoints[0];
  const member = db.kind === "instance" && db.db.clusterId;

  return (
    <div className="connect-tab">
      {!main ? (
        <div className="warn-note">This database has no endpoint yet{d.status ? ` (it's ${d.status})` : ""}. Connection details appear once it's available.</div>
      ) : (
        <>
          {member && (
            <div className="hint">
              This is an instance of cluster <span className="mono">{db.db.clusterId}</span>. Applications normally connect through the cluster's endpoints.
            </div>
          )}
          <table className="props-table connect-table">
            <tbody>
              {endpoints.map((e) => (
                <CopyRow key={e.label} shell={shell} label={e.label} text={e.host} />
              ))}
              <CopyRow shell={shell} label="Port" text={String(port)} />
              <CopyRow shell={shell} label="User" text={user} />
              {database && <CopyRow shell={shell} label="Database" text={database} />}
              <tr>
                <th>Password</th>
                <td colSpan={2}>
                  {d.masterSecretArn ? (
                    <>
                      In Secrets Manager: <span className="mono">{secretName(d.masterSecretArn)}</span>{" "}
                      <button className="link-btn" onClick={() => void shell.copyText(d.masterSecretArn!)}>
                        Copy ARN
                      </button>
                    </>
                  ) : (
                    "Set when the database was created (AWS doesn't store it). Change it with Modify in the AWS console if it's lost."
                  )}
                </td>
              </tr>
              {db.kind === "instance" && (
                <tr>
                  <th>Network</th>
                  <td colSpan={2}>
                    {db.db.publiclyAccessible
                      ? "Publicly accessible: reachable from the internet where its security groups allow it."
                      : `Private: reachable only from inside ${db.db.vpcId ?? "its VPC"} (or over a VPN, Direct Connect or a bastion host).`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="props-section">Clients</div>
          {endpoints.map((e) => (
            <div key={e.label} className="connect-group">
              {endpoints.length > 1 && <div className="form-label">{e.label}</div>}
              <table className="props-table connect-table">
                <tbody>
                  {snippets(family, d.engine, e.host, port, user, database).map((s) => (
                    <CopyRow key={s.label} shell={shell} label={s.label} text={s.text} />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {d.iamAuth && (
            <>
              <div className="props-section">IAM authentication</div>
              <p className="hint">IAM database authentication is on: use a 15-minute token as the password (the database user must be granted rds_iam).</p>
              <table className="props-table connect-table">
                <tbody>
                  <CopyRow
                    shell={shell}
                    label="Token"
                    text={`aws rds generate-db-auth-token --hostname ${main.host} --port ${port} --username ${user} --region ${region}${profile && profile !== "default" ? ` --profile ${profile}` : ""}`}
                  />
                </tbody>
              </table>
            </>
          )}
          <p className="hint">
            Connections use TLS. For full certificate checks, download the RDS CA bundle (global-bundle.pem from truststore.pki.rds.amazonaws.com) and use
            verify-full / VERIFY_IDENTITY.
          </p>
        </>
      )}
    </div>
  );
}
