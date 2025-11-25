import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "./routes";

const app = express();

/* -----------------------------
   CORS CONFIGURATION
------------------------------ */

const allowedOrigins = (process.env.CORS_ALLOWED || "https://racktrack.ai")
  .split(",")
  .map((o) => o.trim());

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return callback(null, true); // allow server-to-server
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

// CORS middleware applied to all routes
app.use(cors(corsOptions as any));

// Ensure preflight requests are handled
app.options("*", cors(corsOptions as any));

/* -----------------------------
   LOGGING FOR CORS + REQUESTS
------------------------------ */

app.use((req, _res, next) => {
  if (req.method === "OPTIONS") {
    console.log("[CORS] Preflight from:", req.headers.origin, "->", req.path);
  }
  next();
});

app.use((req, res, next) => {
  try {
    const origin = (req.headers.origin as string | undefined) ?? null;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", corsOptions.methods.join(","));
      res.setHeader("Access-Control-Allow-Headers", corsOptions.allowedHeaders.join(","));
    }
  } catch {
    // ignore
  }
  next();
});

/* -----------------------------
   PERFORMANCE + API LOGGING
------------------------------ */

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  let jsonResponse: any = undefined;

  const originalJson = res.json.bind(res);
  res.json = (body, ...args) => {
    jsonResponse = body;
    return originalJson(body, ...args);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;

    if (path.startsWith("/api")) {
      let line = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (jsonResponse) line += ` :: ${JSON.stringify(jsonResponse)}`;
      if (line.length > 80) line = line.substring(0, 79) + "…";
      log(line);
    }

    try {
      const allowOrigin = res.getHeader("Access-Control-Allow-Origin");
      if (allowOrigin) {
        log(`[CORS] Access-Control-Allow-Origin: ${allowOrigin} for ${req.method} ${path}`);
      } else if (path.startsWith("/api")) {
        log(`[CORS] No Access-Control-Allow-Origin for ${req.method} ${path}, origin: ${req.headers.origin}`);
      }
    } catch {
      // ignore
    }
  });

  next();
});

/* -----------------------------
   REGISTER API ROUTES
------------------------------ */

(async () => {
  const server = await registerRoutes(app);

  /* -----------------------------
     ERROR HANDLER (always last)
  ------------------------------ */
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    throw err;
  });

  /* -----------------------------
     NO FRONTEND HERE
     (Frontend deployed on cPanel)
  ------------------------------ */

  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`Backend running on port ${port}`);
    }
  );
})();

/* -----------------------------
   SIMPLE LOGGER
------------------------------ */
function log(message: string) {
  console.log(message);
}
