import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "./routes";

// Global logger used everywhere in server
const log = (...args: any[]) => console.log("[server]", ...args);

const app = express();

/* -----------------------------
   CORS CONFIGURATION
------------------------------ */

const allowedOrigins = (process.env.CORS_ALLOWED || "https://racktrack.ai")
  .split(",")
  .map((o) => o.trim());

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

app.use(cors(corsOptions as any));
app.options("*", cors(corsOptions as any));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
  });

  next();
});

/* -----------------------------
   REGISTER API ROUTES (NO VITE)
------------------------------ */

(async () => {
  const server = await registerRoutes(app);

  // Global error handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    throw err;
  });

  // No frontend. No Vite. No static serving.
  // This is a pure backend API.

  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
    }
  );
})();
