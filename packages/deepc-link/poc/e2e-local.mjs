// poc/e2e-local.ts
import { createServer as createServer2 } from "node:http";

// src/cloudflared.ts
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
var PINNED_VERSION = "2026.8.2";
function assetName(platform, arch) {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
  return `cloudflared-${os}-${arch}${platform === "win32" ? ".exe" : ""}`;
}
var QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
function normalizeArch(arch) {
  switch (arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    case "arm":
      return "arm";
    case "ia32":
      return "386";
    default:
      return arch;
  }
}
function createCloudflaredManager(opts = {}) {
  const binDir = opts.binDir ?? join(homedir(), ".deepc", "bin");
  const log2 = opts.log ?? ((m) => console.log(`[deepc:cloudflared] ${m}`));
  const isWin = process.platform === "win32";
  const exeName = isWin ? "cloudflared.exe" : "cloudflared";
  const binPath = join(binDir, exeName);
  let child = null;
  let lastExit = null;
  let reportedUrl = null;
  async function existingUsable() {
    try {
      const st = await stat(binPath);
      return st.size > 1e6;
    } catch {
      return false;
    }
  }
  async function download(url2, dest) {
    log2(`\u4E0B\u8F7D ${url2}`);
    const res = await fetch(url2, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const hash = createHash("sha256");
    const tmp = dest + ".part";
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(
      Readable.fromWeb(res.body),
      new (await import("node:stream")).Writable({
        write(chunk, _enc, cb) {
          hash.update(chunk);
          cb();
        }
      })
    );
    const res2 = await fetch(url2, { redirect: "follow" });
    if (!res2.body) throw new Error("no-body");
    const ws = createWriteStream(tmp);
    await pipeline(Readable.fromWeb(res2.body), ws);
    await chmod(tmp, 493);
    await writeFile(dest + ".sha256", hash.digest("hex"));
    const st = await stat(tmp);
    if (st.size < 1e6) throw new Error("binary-too-small");
    return tmp;
  }
  return {
    async ensureBinary() {
      if (await existingUsable()) {
        log2(`\u4F7F\u7528\u5DF2\u6709\u4E8C\u8FDB\u5236 ${binPath}`);
        return { path: binPath, fromCache: true };
      }
      const asset = assetName(process.platform, normalizeArch(process.arch));
      const url2 = opts.downloadUrl?.(PINNED_VERSION, asset) ?? `https://github.com/cloudflare/cloudflared/releases/download/${PINNED_VERSION}/${asset}`;
      try {
        const tmp = await download(url2, binPath);
        await writeFile(binPath, await readFile(tmp));
        await chmod(binPath, 493);
        log2(`\u5DF2\u4E0B\u8F7D\u5E76\u5B89\u88C5 ${binPath}`);
        return { path: binPath, fromCache: false };
      } catch (err) {
        log2(
          `\u4E0B\u8F7D\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}\u3002\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u8BD5\uFF0C\u6216\u624B\u52A8\u4E0B\u8F7D ${asset} \u653E\u7F6E\u5230 ${binPath}\uFF08\u68C0\u6D4B\u5230\u5373\u8DF3\u8FC7\u4E0B\u8F7D\uFF09\u3002`
        );
        throw new Error("cloudflared-download-failed");
      }
    },
    start(args) {
      return new Promise((resolve, reject) => {
        if (child) {
          resolve();
          return;
        }
        if (!binPath) {
          reject(new Error("binary-not-ready"));
          return;
        }
        reportedUrl = null;
        child = spawn(binPath, args, {
          stdio: ["ignore", "pipe", "pipe"]
        });
        const extract = (chunk) => {
          const m = QUICK_URL_RE.exec(chunk);
          if (m && m[0] !== reportedUrl) {
            reportedUrl = m[0];
            log2(`Quick Tunnel URL: ${reportedUrl}`);
            opts.onUrl?.(reportedUrl);
          }
        };
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => extract(chunk));
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk) => {
          extract(chunk);
          const line = chunk.trim();
          if (line) log2(line);
        });
        child.on("exit", (code2) => {
          lastExit = code2;
          log2(`cloudflared \u9000\u51FA\uFF08code=${code2}\uFF09`);
          child = null;
          reportedUrl = null;
        });
        child.on("error", (err) => {
          log2(`cloudflared \u542F\u52A8\u5931\u8D25\uFF1A${err.message}`);
          child = null;
          reject(err);
        });
        resolve();
      });
    },
    async stop() {
      if (!child) return;
      child.kill("SIGTERM");
      await new Promise((r2) => {
        const timer = setTimeout(() => {
          child?.kill("SIGKILL");
          r2();
        }, 5e3);
        child?.once("exit", () => {
          clearTimeout(timer);
          r2();
        });
      });
      child = null;
      reportedUrl = null;
    },
    alive() {
      return child !== null && child.exitCode === null;
    },
    exitCode() {
      return lastExit;
    }
  };
}

// src/auth-proxy.ts
import { createServer, request } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
var UPSTREAM = "http://127.0.0.1:3080";
var AUTH_PATH = "/__deepc_auth";
var COOKIE_NAME = "dc_site";
var RATE_WINDOW_MS = 6e4;
var RATE_MAX = 5;
var LOCK_THRESHOLD = 10;
var LOCK_MS = 5 * 6e4;
var TICKET_TTL_MS = 6e4;
var TICKET_PREFIX = "deepc-ticket:";
function hmacHex(secret, data) {
  return createHmac("sha256", secret).update(data).digest("hex");
}
function constantEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
function sendJson(res, code2, data) {
  const body2 = JSON.stringify(data);
  res.writeHead(code2, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body2),
    "Cache-Control": "no-store"
  });
  res.end(body2);
}
function readBody(req, max = 16 * 1024) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > max) {
        resolve("");
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", () => resolve(""));
  });
}
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
function authPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>deepc-link \u5B89\u5168\u9A8C\u8BC1</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#1a1d24;border:1px solid #2a2e38;border-radius:12px;
        padding:28px 32px;max-width:340px;width:100%}
  h1{font-size:16px;margin:0 0 16px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;
        border:1px solid #2a2e38;background:#0f1115;color:#e6e6e6;font-size:14px}
  button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;
         background:#4f6ef7;color:#fff;font-size:14px;cursor:pointer}
  .err{color:#ff6b6b;font-size:12px;min-height:16px;margin-top:8px}
  .hint{color:#8a8f98;font-size:12px;margin-top:12px}
</style></head><body>
<div class="card">
  <h1>deepc-link \u5B89\u5168\u9A8C\u8BC1</h1>
  <form method="post" action="${AUTH_PATH}" id="f">
    <input type="password" name="code" placeholder="\u5B89\u5168\u7801" autocomplete="off" autofocus>
    <button type="submit">\u8FDB\u5165</button>
    <div class="err" id="err"></div>
  </form>
  <div class="hint">\u672C\u8FDE\u63A5\u9700\u8981\u5B89\u5168\u7801\u9A8C\u8BC1\uFF08\u7531 deepc.cn \u540E\u53F0\u4E0B\u53D1\uFF09</div>
</div>
<script>
  var f = document.getElementById('f')
  f.addEventListener('submit', function (e) {
    if (location.hash === '#auto') e.preventDefault() // iframe \u81EA\u52A8\u8FC7\u9274\u6743\u4E0D\u5728\u6B64\u9875\u63D0\u4EA4
  })
</script>
</body></html>`;
}
function createAuthProxy(opts = {}) {
  const port = opts.port ?? 3081;
  const upstream = opts.upstream ?? UPSTREAM;
  const log2 = opts.log ?? ((m) => console.log(`[deepc:3081] ${m}`));
  let code2 = opts.securityCode ?? null;
  const attempts = [];
  let lockedUntil = 0;
  const audit = [];
  const seenTickets = /* @__PURE__ */ new Map();
  function pruneAudit() {
    while (audit.length > 50) audit.shift();
  }
  function isLocked(now = Date.now()) {
    if (lockedUntil === 0) return false;
    if (now >= lockedUntil) {
      lockedUntil = 0;
      return false;
    }
    return true;
  }
  function recordFailure() {
    const now = Date.now();
    while (attempts.length && now - attempts[0] > RATE_WINDOW_MS) attempts.shift();
    if (attempts.length >= RATE_MAX) return true;
    attempts.push(now);
    if (attempts.length >= LOCK_THRESHOLD) {
      lockedUntil = now + LOCK_MS;
      attempts.length = 0;
      log2(`[security] \u8FDE\u8D25 ${LOCK_THRESHOLD} \u6B21\uFF0C\u9501\u5B9A ${LOCK_MS / 1e3}s`);
      return true;
    }
    return false;
  }
  function auditLog(ip, ok) {
    audit.push({ at: Date.now(), ip, ok });
    pruneAudit();
  }
  function verifyCode(input) {
    if (!code2) return false;
    if (!constantEqual(hmacHex(input, "deepc-auth"), hmacHex(code2, "deepc-auth"))) return false;
    attempts.length = 0;
    return true;
  }
  function verifyTicket(input) {
    if (!code2) return false;
    const parts = input.split(".");
    if (parts.length !== 2) return false;
    const [exp, sig] = parts;
    const expNum = Number(exp);
    if (!Number.isFinite(expNum)) return false;
    const now = Date.now();
    if (now > expNum) return false;
    if (now < expNum - TICKET_TTL_MS - 5e3) return false;
    const key = `${exp}:${sig}`;
    if (seenTickets.has(key)) return false;
    const expect = hmacHex(code2, `${TICKET_PREFIX}${exp}`);
    if (!constantEqual(sig, expect)) return false;
    seenTickets.set(key, now);
    if (seenTickets.size > 1e3) {
      const oldest = seenTickets.keys().next().value;
      if (oldest !== void 0) seenTickets.delete(oldest);
    }
    return true;
  }
  function verifyCookie(cookie) {
    if (!code2) return false;
    const parts = cookie.split(".");
    if (parts.length !== 2) return false;
    const [exp, sig] = parts;
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || Date.now() > expNum) return false;
    const expect = hmacHex(code2, `deepc-cookie:${exp}`);
    return constantEqual(sig, expect);
  }
  function setCookieHeader(res, secret) {
    const exp = Date.now() + 7 * 24 * 3600 * 1e3;
    const sig = hmacHex(secret, `deepc-cookie:${exp}`);
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${exp}.${sig}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=${7 * 24 * 3600}`
    );
  }
  async function handleAuth(req, res) {
    const now = Date.now();
    const ip = req.socket.remoteAddress ?? "unknown";
    const body2 = await readBody(req);
    let input = "";
    let viaTicket = false;
    try {
      const parsed = new URLSearchParams(body2);
      const raw = parsed.get("code") ?? parsed.get("ticket") ?? "";
      input = raw.trim();
      viaTicket = parsed.get("ticket") !== null;
    } catch {
      input = "";
    }
    if (isLocked(now)) {
      auditLog(ip, false);
      sendJson(res, 429, { ok: false, error: "locked" });
      return;
    }
    const ok = viaTicket ? verifyTicket(input) : verifyCode(input);
    if (!ok) {
      auditLog(ip, false);
      if (recordFailure()) {
        sendJson(res, 429, { ok: false, error: "locked" });
        return;
      }
      sendJson(res, 401, { ok: false, error: "bad-code" });
      return;
    }
    auditLog(ip, true);
    setCookieHeader(res, code2);
    const origin = req.headers.referer;
    let back = "/";
    if (origin) {
      try {
        const u = new URL(origin);
        back = u.pathname + (u.search || "");
      } catch {
        back = "/";
      }
    }
    res.writeHead(302, { Location: back, "Cache-Control": "no-store" });
    res.end();
  }
  function proxyHttp(req, res) {
    const u = new URL(req.url ?? "/", upstream);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v) continue;
      if (k.toLowerCase() === "host" || k.toLowerCase() === "set-cookie") continue;
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, item);
      } else {
        headers.set(k, v);
      }
    }
    const init = Object.assign(
      {
        method: req.method ?? "GET",
        headers,
        body: ["GET", "HEAD"].includes(req.method ?? "") ? void 0 : req.body,
        redirect: "manual"
      },
      { duplex: "half" }
    );
    fetch(u, init).then((upRes) => {
      res.writeHead(upRes.status, {
        "content-type": upRes.headers.get("content-type") ?? "text/plain; charset=utf-8",
        ...Object.fromEntries(
          [...upRes.headers.entries()].filter(
            ([k]) => !["content-type", "transfer-encoding", "connection"].includes(k.toLowerCase())
          )
        )
      });
      const body2 = upRes.body;
      if (body2) {
        const reader = body2.getReader();
        const pump = () => {
          reader.read().then(({ done, value }) => {
            if (done) {
              res.end();
              return;
            }
            res.write(Buffer.from(value));
            pump();
          });
        };
        pump();
      } else {
        res.end();
      }
    }).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 502, { ok: false, error: "upstream-unreachable" });
      } else {
        res.end();
      }
    });
  }
  function proxyWs(req, socket, head) {
    const u = new URL(req.url ?? "/", upstream);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v || k.toLowerCase() === "host") continue;
      headers[k] = v;
    }
    const upReq = request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: req.method ?? "GET",
        headers
      },
      (upRes) => {
        socket.write(
          `HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? ""}\r
`
        );
        socket.end();
        upRes.resume();
      }
    );
    upReq.on("upgrade", (upRes, upSocket, upHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r
Upgrade: websocket\r
Connection: Upgrade\r
${Object.entries(upRes.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r
`).join("")}\r
`
      );
      if (head && head.length) upSocket.write(head);
      if (upHead && upHead.length) socket.write(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    upReq.on("error", () => socket.destroy());
    upReq.end(head.length ? head : void 0);
  }
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "POST" && pathname === AUTH_PATH) {
      void handleAuth(req, res);
      return;
    }
    const cookies = parseCookies(req);
    const dc = cookies[COOKIE_NAME];
    if (!dc || !verifyCookie(dc)) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(authPage());
      return;
    }
    proxyHttp(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    const cookies = parseCookies(req);
    const dc = cookies[COOKIE_NAME];
    if (!dc || !verifyCookie(dc)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    proxyWs(req, socket, head);
  });
  return {
    setSecurityCode(next) {
      code2 = next;
      attempts.length = 0;
      lockedUntil = 0;
      seenTickets.clear();
      log2("[security] \u5B89\u5168\u7801\u5DF2\u8F6E\u6362\uFF08\u9650\u901F/\u9501\u5B9A/ticket \u9632\u91CD\u653E\u5168\u90E8\u91CD\u7F6E\uFF09");
    },
    getSecurityCode() {
      return code2;
    },
    start() {
      return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
          log2(`\u9274\u6743\u4EE3\u7406\u5DF2\u542F\u52A8 :${port} \u2192 ${upstream}`);
          resolve();
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    }
  };
}

// src/device-auth.ts
var DEFAULT_SIGNAL_BASE = "https://deepc.cn";

// src/tunnel.ts
var URL_TIMEOUT_MS = 3e4;
function createTunnelManager(opts) {
  const signalBase = opts.signalBase ?? DEFAULT_SIGNAL_BASE;
  const log2 = opts.log ?? ((m) => console.log(`[deepc:tunnel] ${m}`));
  const proxy = createAuthProxy({ log: log2 });
  const cf = createCloudflaredManager({
    log: log2,
    onUrl: (u) => {
      currentUrl = u;
    }
  });
  let currentUrl = null;
  let connected = false;
  let codeRotated = false;
  let pendingUrl = null;
  async function reportApi(url2) {
    try {
      const res = await fetch(`${signalBase}/auth/tunnel/report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.token}`
        },
        body: JSON.stringify({
          nodeId: opts.nodeId,
          nodeName: opts.nodeName ?? opts.nodeId,
          url: url2
        })
      });
      if (!res.ok) return { ok: false, error: `report-${res.status}` };
      const body2 = await res.json();
      if (body2.ok !== true) return { ok: false, error: body2.error ?? "report-failed" };
      return { ok: true, code: body2.securityCode ?? body2.code };
    } catch {
      return { ok: false, error: "network-error" };
    }
  }
  function waitUrl() {
    if (!pendingUrl) {
      pendingUrl = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("tunnel-url-timeout")), URL_TIMEOUT_MS);
        const check = () => {
          if (currentUrl) {
            clearTimeout(timer);
            resolve(currentUrl);
            return;
          }
        };
        const iv = setInterval(() => {
          if (currentUrl) {
            clearTimeout(timer);
            clearInterval(iv);
            resolve(currentUrl);
          }
        }, 500);
        void check;
      });
    }
    return pendingUrl;
  }
  return {
    async connect() {
      await proxy.start();
      try {
        await cf.ensureBinary();
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "binary-error" };
      }
      pendingUrl = null;
      try {
        await cf.start(["tunnel", "--url", "http://127.0.0.1:3081", "--no-autoupdate"]);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "cloudflared-start-failed"
        };
      }
      let url2;
      try {
        url2 = await waitUrl();
      } catch (err) {
        await cf.stop();
        return {
          ok: false,
          error: err instanceof Error ? err.message : "tunnel-url-timeout"
        };
      }
      const r2 = await reportApi(url2);
      if (!r2.ok) {
        await cf.stop();
        return { ok: false, error: r2.error };
      }
      if (r2.code) {
        proxy.setSecurityCode(r2.code);
        codeRotated = true;
        log2("\u5B89\u5168\u7801\u5DF2\u8F6E\u6362\u5E76\u6CE8\u5165 3081\uFF08\u4EC5\u5185\u5B58\uFF09");
      }
      connected = true;
      log2(`\u5DF2\u8FDE\u63A5\uFF1A${url2}`);
      return { ok: true, url: url2 };
    },
    async disconnect() {
      await cf.stop();
      connected = false;
      currentUrl = null;
      pendingUrl = null;
    },
    securityCode() {
      return proxy.getSecurityCode();
    },
    url() {
      return currentUrl;
    },
    status() {
      return {
        connected,
        url: currentUrl,
        codeRotated,
        cloudflaredAlive: cf.alive()
      };
    }
  };
}

// poc/e2e-local.ts
var WORKER_BASE = process.env.E2E_WORKER ?? "http://127.0.0.1:8787";
var TOKEN = process.env.E2E_TOKEN ?? "dev-token-real-test-001";
var NODE_ID = process.env.E2E_NODE_ID ?? "11111111-2222-3333-4444-555555555555";
var NODE_NAME = process.env.E2E_NODE_NAME ?? "e2e-local-win11";
var log = (m) => console.log(`[e2e] ${m}`);
var mock3080 = createServer2((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<html><body><h1>MOCK DSH UI :3080</h1><p>path=${req.url ?? "/"}</p></body></html>`
  );
});
await new Promise((r2) => mock3080.listen(3080, "127.0.0.1", r2));
log("mock dsh 3080 \u4E0A\u6E38\u5DF2\u542F\u52A8");
var tm = createTunnelManager({
  signalBase: WORKER_BASE,
  token: TOKEN,
  nodeId: NODE_ID,
  nodeName: NODE_NAME,
  log: (m) => console.log(`  [tunnel] ${m}`)
});
log("connect() \u5F00\u59CB\uFF1A3081 \u542F\u52A8 \u2192 cloudflared \u2192 \u89E3\u6790 URL \u2192 report \u6362\u7801");
var r = await tm.connect();
log(`connect() = ${JSON.stringify(r)}`);
if (!r.ok || !r.url) {
  log("\u2717 connect \u5931\u8D25\uFF0C\u7EC8\u6B62");
  process.exit(1);
}
var url = r.url;
var code = tm.securityCode();
log(`\u2713 tunnel URL: ${url}`);
log(`\u2713 \u5B89\u5168\u7801(\u4EC5\u5185\u5B58): ${code?.slice(0, 8)}\u2026(${code?.length}hex)`);
log(`\u2713 status: ${JSON.stringify(tm.status())}`);
var listRes = await fetch(`${WORKER_BASE}/auth/tunnel/list`, {
  headers: { Authorization: `Bearer ${TOKEN}` }
});
var listBody = await listRes.json();
var mine = listBody.nodes?.find((n) => n.nodeId === NODE_ID);
log(`\u2713 Worker list \u53EF\u89C1: url=${mine?.url}\uFF08list=${listRes.status}\uFF09`);
if (mine?.url !== url) log("\u26A0 list URL \u4E0E\u672C\u5730\u4E0D\u4E00\u81F4\uFF08\u53EF\u80FD\u70ED\u91CD\u8F7D\u7ADE\u6001\uFF0C\u7A0D\u540E\u590D\u9A8C\uFF09");
var noAuth = await fetch("http://127.0.0.1:3081/");
log(`[a] \u65E0 cookie GET / \u2192 ${noAuth.status}\uFF08\u671F\u671B 401\uFF09`);
if (noAuth.status !== 401) log("\u26A0 \u671F\u671B 401 \u672A\u547D\u4E2D");
var accRes = await fetch(
  `${WORKER_BASE}/auth/tunnel/access?node=${encodeURIComponent(NODE_ID)}`,
  { headers: { Authorization: `Bearer ${TOKEN}` } }
);
var acc = await accRes.json();
log(`[b] Worker access \u2192 ok=${acc.ok} url=${acc.url}`);
if (!acc.ticket) {
  log("\u2717 \u65E0 ticket\uFF0C\u7EC8\u6B62");
  process.exit(1);
}
var form = new URLSearchParams({ ticket: acc.ticket });
var authRes = await fetch("http://127.0.0.1:3081/__deepc_auth", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: form.toString(),
  redirect: "manual"
});
var setCookie = authRes.headers.get("set-cookie") ?? "";
var location = authRes.headers.get("location") ?? "";
log(`[b] POST /__deepc_auth \u2192 ${authRes.status}\uFF08\u671F\u671B 302\uFF09Location=${location}`);
log(`[b] Set-Cookie: ${setCookie.split(";")[0]}\uFF08\u542B Partitioned=${setCookie.includes("Partitioned")}\uFF09`);
var cookieVal = setCookie.split(";")[0];
var authed = await fetch("http://127.0.0.1:3081/", {
  headers: { Cookie: cookieVal }
});
var body = await authed.text();
log(`[c] \u5E26 dc_site cookie GET / \u2192 ${authed.status}\uFF08\u671F\u671B 200 \u53CD\u4EE3 3080\uFF09`);
log(`[c] \u5185\u5BB9\u5305\u542B MOCK: ${body.includes("MOCK DSH UI")}`);
log("");
log(`\u516C\u7F51\u94FE\u8DEF\u9A8C\u8BC1\uFF08\u6D4F\u89C8\u5668 / curl \u6253\u771F\u5B9E trycloudflare URL\uFF09\uFF1A`);
log(`  curl -v ${url}/__deepc_auth -X POST -d 'ticket=${acc.ticket}' -D -`);
log(`  \uFF08\u6B63\u5E38\u6D41\u7A0B\uFF1A\u524D\u7AEF iframe auto-post ticket \u2192 302 Set-Cookie \u2192 302 \u56DE ${url}/\uFF09`);
log("");
var hold = Number(process.env.E2E_HOLD_SECONDS ?? 30);
log(`e2e \u5B8C\u6210 \u2705 \u4FDD\u6301\u8FDB\u7A0B ${hold}s\uFF08\u4F9B\u624B\u52A8 curl \u516C\u7F51 URL\uFF09\u2026`);
await new Promise((r2) => setTimeout(r2, hold * 1e3));
await tm.disconnect();
mock3080.close();
log("\u5DF2\u65AD\u5F00 cloudflared + 3081 + mock 3080\uFF0C\u9000\u51FA");
process.exit(0);
