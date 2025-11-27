import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// __dirname replacement in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function scanFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf8");

  // Forbidden secrets (server-only)
  const forbidden = [
    "RESEND_API_KEY",
    "GMAIL_APP_PASSWORD",
    "SMTP_PASSWORD",
    "GMAIL_APP_PASSWORD"
  ];

  return forbidden.some(k => content.includes(k));
}

const clientEnvPath = path.join(__dirname, "..", "client", ".env.production");
const foundInClient = scanFile(clientEnvPath);

if (foundInClient) {
  console.error(
    "ERROR: Found backend secret(s) in client/.env.production — remove them and put them in backend .env only."
  );
  process.exit(1);
}

console.log("Secret checks passed.");
