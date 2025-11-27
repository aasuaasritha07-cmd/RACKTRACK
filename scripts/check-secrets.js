const fs = require('fs');
const path = require('path');

function scanFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  // Don't allow server-side secrets to be accidentally committed into client env.
  // Exceptions: Vite-exposed public keys such as VITE_EMAILJS_PUBLIC_KEY are allowed.
  const forbidden = ['RESEND_API_KEY', 'GMAIL_APP_PASSWORD', 'SMTP_PASSWORD', 'GMAIL_APP_PASSWORD'];
  return forbidden.some(k => content.includes(k));
}

const clientEnvPath = path.join(__dirname, '..', 'client', '.env.production');
const foundInClient = scanFile(clientEnvPath);
if (foundInClient) {
  console.error(`ERROR: Found backend secret(s) in client/.env.production — remove them and put them in backend .env only.`);
  process.exit(1);
}

console.log('Secret checks passed.');
