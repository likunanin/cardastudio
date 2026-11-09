// CADRA backend — no dependencies. Requires Node 18+.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_PASSWORD;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const SITE_URL = new URL(process.env.SITE_URL || "https://cadrastudio.online.ge").origin;
const PUB = path.join(__dirname, "public");
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || "data");
const DB = path.join(DATA_DIR, "orders.json");
const BACKUPS = path.join(DATA_DIR, "backups");
const ORDER_STATUSES = new Set(["new", "contacted", "in progress", "done"]);

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

const compressible = new Set([
  "application/json; charset=utf-8",
  "application/xml; charset=utf-8",
  "image/svg+xml",
  "text/css; charset=utf-8",
  "text/html; charset=utf-8",
  "text/javascript; charset=utf-8",
  "text/plain; charset=utf-8",
]);

const read = () => {
  let contents;
  try {
    contents = fs.readFileSync(DB, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const orders = JSON.parse(contents);
  if (!Array.isArray(orders)) {
    throw new Error("Order data must be a JSON array");
  }

  return orders.map((order) => ({
    ...order,
    status: ORDER_STATUSES.has(order.status) ? order.status : "new",
  }));
};

const write = (data) => {
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  const temporaryFile = `${DB}.${process.pid}.${crypto.randomUUID()}.tmp`;

  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2));
    fs.renameSync(temporaryFile, DB);
  } catch (error) {
    if (fs.existsSync(temporaryFile)) {
      fs.unlinkSync(temporaryFile);
    }
    throw error;
  }
};

const createDailyBackup = () => {
  if (!fs.existsSync(DB)) {
    return;
  }

  fs.mkdirSync(BACKUPS, { recursive: true });
  const backupName = `orders-${new Date().toISOString().slice(0, 10)}.json`;
  const backupPath = path.join(BACKUPS, backupName);
  const temporaryFile = `${backupPath}.${process.pid}.${crypto.randomUUID()}.tmp`;

  try {
    fs.copyFileSync(DB, temporaryFile);
    fs.renameSync(temporaryFile, backupPath);
  } catch (error) {
    if (fs.existsSync(temporaryFile)) {
      fs.unlinkSync(temporaryFile);
    }
    throw error;
  }

  const backups = fs
    .readdirSync(BACKUPS)
    .filter((name) => /^orders-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();

  backups.slice(0, Math.max(0, backups.length - 14)).forEach((name) => {
    fs.unlinkSync(path.join(BACKUPS, name));
  });
};

const backupAfterOrderWrite = () => {
  try {
    createDailyBackup();
  } catch (error) {
    console.error("Could not create daily order backup:", error.message);
  }
};

const sendTelegram = async (text) => {
  if (!TG_TOKEN || !TG_CHAT) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
      signal: AbortSignal.timeout(10000),
    }
  );
  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram returned HTTP ${response.status}`);
  }
};

const hits = {};

const send = (res, code, obj) => {
  res.writeHead(code, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(obj));
};

const authed = (req) => {
  if (!ADMIN) {
    return false;
  }

  const provided = Buffer.from(req.headers["x-admin-password"] || "");
  const expected = Buffer.from(ADMIN);
  return (
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected)
  );
};

const clean = (value, maxLength) => String(value || "").slice(0, maxLength).trim();

const acceptsGzip = (header = "") =>
  header.split(",").some((encoding) => {
    const [name, ...parameters] = encoding.trim().split(";");
    return (
      name.trim() === "gzip" &&
      !parameters.some((parameter) => /^\s*q=0(?:\.0*)?\s*$/i.test(parameter))
    );
  });

const setSecurityHeaders = (res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
};

const sendText = (req, res, contentType, body) => {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=3600");

  if (compressible.has(contentType) && acceptsGzip(req.headers["accept-encoding"])) {
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    res.end(zlib.gzipSync(body));
    return;
  }

  res.end(body);
};

http
  .createServer((req, res) => {
    setSecurityHeaders(res);
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("ok");
      return;
    }

    if (url.pathname === "/robots.txt" && req.method === "GET") {
      const body = [
        "User-agent: *",
        "Disallow: /admin.html",
        "Disallow: /api/",
        `Sitemap: ${SITE_URL}/sitemap.xml`,
        "",
      ].join("\n");
      sendText(req, res, "text/plain; charset=utf-8", body);
      return;
    }

    if (url.pathname === "/sitemap.xml" && req.method === "GET") {
      const languages = ["en", "ka", "ru"];
      const alternates = languages
        .map(
          (lang) =>
            `<xhtml:link rel="alternate" hreflang="${lang}" href="${SITE_URL}/?lang=${lang}"/>`
        )
        .join("");
      const body =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">' +
        `<url><loc>${SITE_URL}/</loc>${alternates}<xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}/"/></url>` +
        "</urlset>";
      sendText(req, res, "application/xml; charset=utf-8", body);
      return;
    }

    if (url.pathname === "/api/test-telegram" && req.method === "POST") {
      if (!authed(req)) {
        return send(res, 401, { error: "Unauthorized" });
      }

      sendTelegram("CADRA Telegram test alert — notifications are working.")
        .then(() => send(res, 200, { ok: true }))
        .catch((error) => {
          console.error("Telegram test alert failed:", error.message);
          send(res, 502, { error: `Telegram test failed: ${error.message}` });
        });
      return;
    }

    if (url.pathname === "/api/orders" && req.method === "POST") {
      const forwardedFor = req.headers["x-forwarded-for"];
      const ip =
        typeof forwardedFor === "string"
          ? forwardedFor.split(",")[0].trim() || req.socket.remoteAddress
          : req.socket.remoteAddress;
      const now = Date.now();
      hits[ip] = (hits[ip] || []).filter((time) => now - time < 3600e3);

      if (hits[ip].length >= 10) {
        return send(res, 429, { error: "Too many requests" });
      }

      hits[ip].push(now);
      let body = "";

      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 20000) {
          req.destroy();
        }
      });

      req.on("end", () => {
        let input;
        try {
          input = JSON.parse(body);
        } catch {
          return send(res, 400, { error: "Bad request" });
        }

        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return send(res, 400, { error: "Bad request" });
        }

        const order = {
          id: crypto.randomUUID(),
          name: clean(input.name, 100),
          phone: clean(input.phone, 40),
          email: clean(input.email, 120),
          type: clean(input.type, 60),
          length: clean(input.length, 40),
          package: clean(input.package, 60),
          deadline: clean(input.deadline, 20),
          story: clean(input.story, 5000),
          status: "new",
          created: now,
        };

        if (!order.name || !order.phone || !order.story) {
          return send(res, 400, { error: "Missing fields" });
        }

        try {
          const all = read();
          all.push(order);
          write(all);
        } catch (error) {
          console.error("Could not save CADRA order:", error.message);
          return send(res, 500, { error: "Could not save order" });
        }
        backupAfterOrderWrite();

        if (TG_TOKEN || TG_CHAT) {
          sendTelegram(
            `New CADRA order\n${order.name} · ${order.phone}\nPackage: ${order.package || "-"}\n${order.type} · ${order.length}\nNeeded by: ${order.deadline || "-"}\n\n${order.story}`
          ).catch((error) => {
            console.error("Telegram order alert failed:", error.message);
          });
        }

        send(res, 201, { ok: true });
      });
      return;
    }

    if (url.pathname === "/api/orders" && req.method === "GET") {
      if (!authed(req)) {
        return send(res, 401, { error: "Unauthorized" });
      }
      try {
        return send(res, 200, read().reverse());
      } catch (error) {
        console.error("Could not read CADRA orders:", error.message);
        return send(res, 500, { error: "Could not read orders" });
      }
    }

    if (url.pathname.startsWith("/api/orders/") && req.method === "PATCH") {
      if (!authed(req)) {
        return send(res, 401, { error: "Unauthorized" });
      }

      const id = url.pathname.split("/").pop();
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 20000) {
          req.destroy();
        }
      });
      req.on("end", () => {
        let input;
        try {
          input = JSON.parse(body);
        } catch {
          return send(res, 400, { error: "Bad request" });
        }

        if (!input || typeof input !== "object" || Array.isArray(input) || !ORDER_STATUSES.has(input.status)) {
          return send(res, 400, { error: "Invalid order status" });
        }

        try {
          const orders = read();
          const order = orders.find((item) => item.id === id);
          if (!order) {
            return send(res, 404, { error: "Order not found" });
          }

          order.status = input.status;
          write(orders);
          backupAfterOrderWrite();
          return send(res, 200, { ok: true });
        } catch (error) {
          console.error("Could not update CADRA order:", error.message);
          return send(res, 500, { error: "Could not update order" });
        }
      });
      return;
    }

    if (url.pathname.startsWith("/api/orders/") && req.method === "DELETE") {
      if (!authed(req)) {
        return send(res, 401, { error: "Unauthorized" });
      }

      const id = url.pathname.split("/").pop();
      try {
        const orders = read();
        if (!orders.some((order) => order.id === id)) {
          return send(res, 404, { error: "Order not found" });
        }
        write(orders.filter((order) => order.id !== id));
        backupAfterOrderWrite();
        return send(res, 200, { ok: true });
      } catch (error) {
        console.error("Could not delete CADRA order:", error.message);
        return send(res, 500, { error: "Could not delete order" });
      }
    }

    let filePath;
    try {
      const requestPath = decodeURIComponent(url.pathname);
      const relativePath =
        requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
      filePath = path.resolve(PUB, relativePath);
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    const relativePath = path.relative(PUB, filePath);
    if (
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath) ||
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()
    ) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const contentType =
      types[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const cacheControl =
      path.extname(filePath).toLowerCase() === ".html"
        ? "no-cache"
        : "public, max-age=86400";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", cacheControl);

    if (compressible.has(contentType)) {
      res.setHeader("Vary", "Accept-Encoding");
    }

    const source = fs.createReadStream(filePath);
    source.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end("Unable to read file");
    });

    if (compressible.has(contentType) && acceptsGzip(req.headers["accept-encoding"])) {
      res.setHeader("Content-Encoding", "gzip");
      source.pipe(zlib.createGzip()).pipe(res);
      return;
    }

    source.pipe(res);
  })
  .listen(PORT, () => {
    console.log("CADRA running on http://localhost:" + PORT);
    if (!ADMIN) {
      console.error("ADMIN_PASSWORD is not configured; admin access is disabled.");
    }
    try {
      createDailyBackup();
    } catch (error) {
      console.error("Could not create daily order backup:", error.message);
    }
  });

setInterval(() => {
  try {
    createDailyBackup();
  } catch (error) {
    console.error("Could not create daily order backup:", error.message);
  }
}, 60 * 60 * 1000).unref();
