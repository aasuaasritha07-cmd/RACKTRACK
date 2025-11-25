import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "./routes";


const app = express();

// Configure CORS to allow the frontend origin(s). In production set CORS_ALLOWED
// to a comma-separated list like: "https://racktrack.ai,https://www.racktrack.ai"
const allowedOrigins = (process.env.CORS_ALLOWED || "https://racktrack.ai").split(",").map((o) => o.trim());
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // if no origin (server -> server call, or CLI), allow it
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
    // origin not allowed
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

// CORS middleware applied to all routes
app.use(cors(corsOptions as any));

// Ensure preflight requests are handled and respond with the CORS headers
app.options("*", cors(corsOptions as any));

// lightweight logging for preflight requests so we can track CORS failures
app.use((req, _res, next) => {
  if (req.method === "OPTIONS") {
    console.log("[CORS] Preflight from:", req.headers.origin, "->", req.path);
  }
  next();
});

// Forcefully add Access-Control-Allow-Origin header for explicitly allowed origins.
// This mirrors what the `cors` middleware does but ensures headers are present in unusual proxy scenarios.
app.use((req, res, next) => {
  try {
    const origin = (req.headers.origin as string | undefined) ?? null;
    if (origin && allowedOrigins.indexOf(origin) !== -1) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", corsOptions.methods.join(","));
      res.setHeader("Access-Control-Allow-Headers", corsOptions.allowedHeaders.join(","));
    }
  } catch (e) {
    // swallow
  }
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
    // Log CORS header presence for all requests to help debugging
    try {
      const acAllowOrigin = res.getHeader("Access-Control-Allow-Origin");
      if (acAllowOrigin) {
        log(`[CORS] Response header Access-Control-Allow-Origin: ${acAllowOrigin} for ${req.method} ${path}`);
      } else if (path.startsWith("/api")) {
        log(`[CORS] No Access-Control-Allow-Origin header for ${req.method} ${path}, origin: ${req.headers.origin}`);
      }
    } catch (e) {
      // ignore logging error
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
  port,
  host: "0.0.0.0",
  }, () => {
    log(`serving on port ${port}`);
  });
})();
