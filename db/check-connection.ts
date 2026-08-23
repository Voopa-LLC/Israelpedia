/**
 * Diagnose a database connection failure, one layer at a time.
 *
 *   npm run db:check
 *
 * Prints where the connection breaks — DNS, TCP, TLS, or Postgres auth — so
 * the fix is obvious instead of guessed at. Read-only: it opens a connection,
 * runs `SELECT now()`, and disconnects. Safe to delete once things work.
 */
import "dotenv/config";
import dns from "dns/promises";
import net from "net";
import tls from "tls";
import postgres from "postgres";

function mask(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return "(unparseable)";
  }
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  process.stdout.write(`${label.padEnd(26)} `);
  try {
    const result = await fn();
    console.log("OK");
    return result;
  } catch (err: any) {
    console.log(`FAILED — ${err.code ?? err.message}`);
    return null;
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set — check .env in the project root.");
    process.exit(1);
  }

  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = Number(parsed.port || 5432);

  console.log(`URL   : ${mask(url)}`);
  console.log(`Host  : ${host}:${port}\n`);

  // 1. DNS
  const addrs = await step("1. DNS resolve", () => dns.lookup(host, { all: true }));
  if (addrs) console.log(`   → ${addrs.map((a) => a.address).join(", ")}`);

  // 2. TCP
  const tcpOk = await step(
    "2. TCP connect",
    () =>
      new Promise<boolean>((resolve, reject) => {
        const s = net.connect({ host, port });
        s.setTimeout(15000);
        s.on("connect", () => { s.end(); resolve(true); });
        s.on("timeout", () => { s.destroy(); reject(new Error("TIMEOUT")); });
        s.on("error", reject);
      })
  );

  // 3. Postgres SSL negotiation + TLS handshake
  if (tcpOk) {
    await step(
      "3. TLS handshake",
      () =>
        new Promise<boolean>((resolve, reject) => {
          const s = net.connect({ host, port });
          s.setTimeout(20000);
          s.on("timeout", () => { s.destroy(); reject(new Error("TIMEOUT — no reply to SSLRequest")); });
          s.on("error", reject);
          s.on("connect", () => {
            // Postgres SSLRequest packet: int32 length = 8, int32 code = 80877103
            const packet = Buffer.alloc(8);
            packet.writeInt32BE(8, 0);
            packet.writeInt32BE(80877103, 4);
            s.write(packet);
          });
          s.once("data", (d) => {
            const reply = d.toString("latin1")[0];
            if (reply !== "S") {
              s.end();
              reject(new Error(`server refused TLS (replied "${reply}")`));
              return;
            }
            const t = tls.connect({ socket: s, servername: host }, () => {
              console.log(`   → ${t.getProtocol()}, cert by ${t.getPeerCertificate().issuer?.O ?? "?"}`);
              t.end();
              resolve(true);
            });
            t.on("error", reject);
          });
        })
    );
  }

  // 4. Real Postgres connection + auth
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 30 });
  const rows = await step("4. Postgres auth + query", () => sql`SELECT now() AS now, version() AS version`);
  if (rows) {
    console.log(`   → ${(rows[0] as any).version.split(",")[0]}`);
    console.log("\nThe database is reachable. Re-run: npm run db:migrate-topics");
  } else {
    console.log(
      "\nThe database is NOT reachable.\n" +
        "  • If step 2 or 3 failed: check the Neon console — the project may be\n" +
        "    suspended, over quota, or the endpoint may have changed.\n" +
        "  • If only step 4 failed: the password or database name in .env is wrong.\n" +
        "  • A VPN, corporate proxy or antivirus doing TLS inspection also breaks step 3."
    );
  }
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("\nCheck failed:", err.message ?? err);
  process.exit(1);
});
