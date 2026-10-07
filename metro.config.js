// Proxy für die Backend-API: /chat, /stt, /health, /register-push
// werden an den lokalen pi-Server (Port 3000) weitergeleitet.
// Dadurch spricht die App IMMER denselben Host an wie Metro –
// egal ob Tunnel oder LAN. Kein Firewall-Problem fürs Backend.
const { getDefaultConfig } = require("expo/metro-config");
const http = require("http");

const config = getDefaultConfig(__dirname);

const API_PREFIXES = ["/chat", "/stt", "/health", "/register-push"];

config.server = config.server || {};
config.server.enhanceMiddleware = (middleware) => {
  return (req, res, next) => {
    const url = req.url || "";
    const isApi = API_PREFIXES.some((p) => url === p || url.startsWith(p + "?"));
    if (!isApi) {
      return middleware(req, res, next);
    }

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: 3000,
        path: url,
        method: req.method,
        headers: { ...req.headers, host: "127.0.0.1:3000" },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Backend nicht erreichbar (läuft node server.js?)" }));
    });
    req.pipe(proxyReq);
  };
};

module.exports = config;
