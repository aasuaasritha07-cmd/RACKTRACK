import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { loginCredentialsSchema, insertUploadSchema, insertContactSchema, updateProfileSchema } from "@shared/schema";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import * as cheerio from "cheerio";
import { spawn } from 'child_process';
import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

// ESM-friendly __dirname/__filename
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

const filesDir = "files";
if (!fs.existsSync(filesDir)) {
  fs.mkdirSync(filesDir, { recursive: true });
}

const uploadTypeFolders = ["single-image", "multiple-images", "video"];
uploadTypeFolders.forEach((folder) => {
  const folderPath = path.join(filesDir, folder);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
});

function deleteFilesInFolder(folderPath: string) {
  if (fs.existsSync(folderPath)) {
    const files = fs.readdirSync(folderPath);
    files.forEach((file) => {
      const filePath = path.join(folderPath, file);
      if (fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
      }
    });
  }
}

const allowedTypes: Record<
  string,
  { mimes: string[]; extensions: string[]; maxFiles: number }
> = {
  "single-image": {
    mimes: ["image/jpeg", "image/png", "image/jpg", "image/webp"],
    extensions: [".jpg", ".jpeg", ".png", ".webp"],
    maxFiles: 1,
  },
  "multiple-images": {
    mimes: ["image/jpeg", "image/png", "image/jpg", "image/webp"],
    extensions: [".jpg", ".jpeg", ".png", ".webp"],
    maxFiles: 20,
  },
  video: {
    mimes: ["video/mp4", "video/webm", "video/quicktime"],
    extensions: [".mp4", ".webm", ".mov"],
    maxFiles: 1,
  },
};

const tempDir = path.join(filesDir, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    const safeName = basename.replace(/[^a-zA-Z0-9-_]/g, "_");
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}-${safeName}${ext}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});

/**
 * Clear all files in the segmented_output directory and its subdirectories
 */
function clearSegmentedOutput() {
  const segmentedOutputDir = path.join(process.cwd(), "segmented_output");

  if (!fs.existsSync(segmentedOutputDir)) {
    console.log(
      "[Clear Segments] segmented_output directory does not exist, skipping clear",
    );
    return;
  }

  try {
    const folders = fs.readdirSync(segmentedOutputDir);
    folders.forEach((folder) => {
      const folderPath = path.join(segmentedOutputDir, folder);
      if (fs.statSync(folderPath).isDirectory()) {
        deleteFilesInFolder(folderPath);
      } else if (fs.statSync(folderPath).isFile()) {
        fs.unlinkSync(folderPath);
      }
    });
    console.log("[Clear Segments] Cleared segmented_output folder");
  } catch (error) {
    console.error("[Clear Segments] Error clearing segmented_output:", error);
  }
}

/**
 * Process uploaded files using appropriate Python script based on upload type
 * @param uploadType - Type of upload (single-image, multiple-images, video)
 * @param filePaths - Array of file paths to process
 */
async function processPythonScript(scriptPath: string, imagePath: string) {
    return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
        // Resolve to absolute paths relative to the server file
        const scriptFullPath = path.isAbsolute(scriptPath)
            ? scriptPath
            : path.resolve(__dirname, '..', scriptPath);
        const imageFullPath = path.isAbsolute(imagePath)
            ? imagePath
            : path.resolve(__dirname, '..', imagePath);

        // Debug logs to verify what will be executed
        console.log('Running python with:', scriptFullPath, imageFullPath);

        if (!fs.existsSync(scriptFullPath)) {
            return reject(new Error(`Python script not found: ${scriptFullPath}`));
        }
        if (!fs.existsSync(imageFullPath)) {
            return reject(new Error(`Image file not found: ${imageFullPath}`));
        }

        // Use the venv Python executable so installed packages are available
        const pythonExe = path.join(process.cwd(), ".venv", "Scripts", "python.exe");
        const child = spawn(pythonExe, [scriptFullPath, imageFullPath], { windowsHide: true });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        child.on('error', (err) => reject(err));

        child.on('close', (code) => {
            if (code === 0) resolve({ stdout, stderr, code: code ?? 0 });
            else reject(new Error(`Python exited with code ${code}\n${stderr}`));
        });
    });
}

export async function registerRoutes(app: Express): Promise<Server> {
  // In-memory session store for simple session management
  const sessions = new Map<string, { userId: string | null; username: string }>();

  const getSessionFromHeader = (req: any) => {
    const authHeader = req.headers?.authorization as string | undefined;
    if (!authHeader) return null;
    return authHeader.replace("Bearer ", "");
  };

  app.post("/api/upload", upload.array("files", 20), async (req, res) => {
    try {
      const uploadType = req.body.uploadType;
      const files = req.files as Express.Multer.File[];

      if (!uploadType || !allowedTypes[uploadType]) {
        if (req.files) {
          (req.files as Express.Multer.File[]).forEach((file) => {
            if (fs.existsSync(file.path)) {
              fs.unlinkSync(file.path);
            }
          });
        }
        return res
          .status(400)
          .json({ success: false, message: "Invalid upload type" });
      }

      if (!files || files.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No files uploaded or invalid file types",
        });
      }

      const typeConfig = allowedTypes[uploadType];

      const invalidFiles = files.filter((file) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const isMimeAllowed = typeConfig.mimes.includes(file.mimetype);
        const isExtAllowed = typeConfig.extensions.includes(ext);
        return !isMimeAllowed || !isExtAllowed;
      });

      if (invalidFiles.length > 0) {
        files.forEach((file) => fs.unlinkSync(file.path));
        return res.status(400).json({
          success: false,
          message:
            "Invalid file type(s). Please upload only allowed file formats.",
        });
      }

      if (files.length > typeConfig.maxFiles) {
        files.forEach((file) => fs.unlinkSync(file.path));
        return res.status(400).json({
          success: false,
          message: `Too many files. Maximum ${typeConfig.maxFiles} allowed for ${uploadType}`,
        });
      }

      const typeFolder = path.join(filesDir, uploadType);

      const uploadedFiles = await Promise.all(
        files.map(async (file) => {
          const fileName = path.basename(file.path);
          const newPath = path.join(typeFolder, fileName);

          fs.renameSync(file.path, newPath);

          const uploadData = {
            fileName: file.originalname,
            fileType: file.mimetype,
            filePath: newPath,
            uploadType: uploadType,
          };

          const validatedData = insertUploadSchema.parse(uploadData);
          return await storage.createUpload(validatedData);
        }),
      );

      // Process files with appropriate Python script based on upload type
      // Choose files to process: pick only the most-recent upload to avoid re-processing older files
      let filePaths: string[] = [];
      if (uploadedFiles.length > 0) {
        // choose the uploaded file with the newest mtime
        const withStats = uploadedFiles.map((uf) => ({ path: uf.filePath, mtime: fs.statSync(uf.filePath).mtimeMs }));
        withStats.sort((a, b) => b.mtime - a.mtime);
        // process only the newest file
        filePaths = [withStats[0].path];
      } else {
        // fallback: pick the newest file in the folder for this upload type
        const typeFolder = path.join(filesDir, uploadType);
        if (fs.existsSync(typeFolder)) {
          const files = fs.readdirSync(typeFolder).map((f) => path.join(typeFolder, f));
          const candidates = files.filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());
          if (candidates.length > 0) {
            candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            filePaths = [candidates[0]];
          }
        }
      }

      // Map upload types to Python scripts in `python_codes` folder
      let scriptPath = "";
      if (uploadType === "single-image") {
        scriptPath = path.join(process.cwd(), "python_codes", "single.py");
      } else if (uploadType === "multiple-images") {
        scriptPath = path.join(process.cwd(), "python_codes", "multii.py");
      } else if (uploadType === "video") {
        scriptPath = path.join(process.cwd(), "python_codes", "video.py");
      }

      if (scriptPath) {
        // Run the script for each uploaded file (use absolute paths)
        for (const p of filePaths) {
          const absoluteImagePath = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
          await processPythonScript(scriptPath, absoluteImagePath);
        }
      } else {
        console.warn("No script configured for upload type:", uploadType);
      }

      // After processing, if a generated PDF exists, persist a per-user copy for each upload
      try {
        const sessionId = getSessionFromHeader(req);
        const session = sessionId ? sessions.get(sessionId) : undefined;
        const userId = session?.userId ?? null;

        const pdfPath = path.join(process.cwd(), "Results", "Merged_Result.pdf");
        if (userId && fs.existsSync(pdfPath)) {
          const reportsDir = path.join(process.cwd(), "reports");
          if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

          const userReportsDir = path.join(reportsDir, userId);
          if (!fs.existsSync(userReportsDir)) fs.mkdirSync(userReportsDir, { recursive: true });

          for (const uf of uploadedFiles) {
            const destFilename = `${randomUUID()}.pdf`;
            const destRelative = path.join("reports", userId, destFilename).replace(/\\/g, "/");
            const destAbs = path.join(process.cwd(), destRelative);
            try {
              fs.copyFileSync(pdfPath, destAbs);
            } catch (copyErr) {
              console.error("[Upload] Failed to copy PDF to reports folder:", copyErr);
              continue;
            }

            await storage.createReport({
              userId,
              title: `Merged Result ${new Date().toISOString()}`,
              filename: destFilename,
              pdfPath: destRelative,
              processedImage: uf.filePath,
            });
          }
        }
      } catch (err) {
        console.error("[Upload] Failed to persist per-upload report metadata:", err);
      }

      res.json({
        success: true,
        message: `Successfully uploaded ${uploadedFiles.length} file(s)`,
        uploads: uploadedFiles,
      });
    } catch (error) {
      console.error("Upload error:", error);
      if (req.files) {
        (req.files as Express.Multer.File[]).forEach((file) => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      }
      res.status(500).json({ success: false, message: "Upload failed" });
    }
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Register a new user (minimal, non-intrusive)
  app.post("/api/register", async (req, res) => {
    try {
      const { username, password } = req.body as { username?: string; password?: string };
      if (!username || !password) {
        return res.status(400).json({ success: false, message: "username and password are required" });
      }

      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(400).json({ success: false, message: "Username already exists" });
      }

      const user = await storage.createUser({ username, password } as any);
      res.status(201).json({ success: true, message: "User registered", user: { id: user.id, username: user.username } });
    } catch (err) {
      console.error('Register error:', err);
      res.status(500).json({ success: false, message: 'Registration failed' });
    }
  });

  // Login - create a session and return a sessionId header/token
  app.post("/api/login", async (req, res) => {
    try {
      const credentials = loginCredentialsSchema.parse(req.body);
      const isValid = await storage.validateCredentials(credentials);

      if (!isValid) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }

      const user = await storage.getUserByUsername(credentials.username);
      const sessionId = randomUUID();
      sessions.set(sessionId, { userId: user?.id ?? null, username: credentials.username });

      res.json({ success: true, message: "Login successful", sessionId, user: user ? { id: user.id, username: user.username } : undefined });
    } catch (error) {
      res.status(400).json({ success: false, message: "Invalid request" });
    }
  });

  // Logout - invalidate session
  app.post("/api/logout", (req, res) => {
    const sessionId = getSessionFromHeader(req);
    if (sessionId) sessions.delete(sessionId);
    res.json({ success: true, message: "Logged out" });
  });

  // Contact form submission with email notification
  app.post("/api/contact", async (req, res) => {
    try {
      const contactData = insertContactSchema.parse(req.body);
      const contact = await storage.createContact(contactData);

      // Recipients and email content
      const recipientsEnv = process.env.CONTACT_RECS ?? "aasrithab@sprintpark.com,srikanthm@sprintpark.com";
      const recipients = recipientsEnv.split(",").map((r) => r.trim()).filter(Boolean);
      const emailText = `Name: ${contactData.name}\nEmail: ${contactData.email}\n\n${contactData.message}`;
      const emailHtml = `<p><strong>Name:</strong> ${contactData.name}</p><p><strong>Email:</strong> ${contactData.email}</p><pre>${contactData.message}</pre>`;
      const resendApiKey = process.env.RESEND_API_KEY;
      const resendFrom = process.env.RESEND_FROM ?? process.env.GMAIL_FROM ?? process.env.GMAIL_USER ?? "no-reply@racktrack.ai";
      let anySendErrors = false;

      // Prepare SMTP transporter (fallback)
      const transporter = nodemailer.createTransport({
        service: process.env.GMAIL_SERVICE ?? "gmail",
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
        secure: process.env.SMTP_SECURE === "true",
        auth: {
          user: process.env.GMAIL_USER ?? "",
          pass: process.env.GMAIL_PASS ?? "",
        },
        connectionTimeout: 15000,
        socketTimeout: 15000,
      });

        // If Resend API key is present, use API-based sending to avoid SMTP network failures
        if (resendApiKey) {
          for (const rcp of recipients) {
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 15000);
              const resp = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${resendApiKey}`,
                },
                body: JSON.stringify({
                  from: resendFrom,
                  to: rcp,
                  subject: `New Contact Form Message from ${contactData.name}`,
                  html: emailHtml,
                  text: emailText,
                }),
                signal: controller.signal,
              });
              clearTimeout(timeout);
              if (!resp.ok) {
                anySendErrors = true;
                const body = await resp.text().catch(() => "");
                console.warn("[Resend] send failed", resp.status, resp.statusText, body);
              }
            } catch (err) {
              anySendErrors = true;
              console.error("[Resend] send error:", err);
            }
          }
        } else {
          // fallback to SMTP using nodemailer
          try {
            await new Promise<void>((resolve, reject) => transporter.verify((err) => (err ? reject(err) : resolve())));
          } catch (verifyErr) {
            console.warn("[SMTP] verify failed:", verifyErr);
          }

          for (const rcp of recipients) {
            try {
              await transporter.sendMail({
                from: process.env.GMAIL_FROM ?? process.env.GMAIL_USER ?? "",
                to: rcp,
                subject: `New Contact Form Message from ${contactData.name}`,
                text: emailText,
              });
            } catch (err) {
              anySendErrors = true;
              console.error("[SMTP] send error:", err);
            }
          }
        }

      res.status(201).json({ success: true, message: "Message received and email sent", contact });
    } catch (error) {
      console.error("Contact form error:", error);
      res.status(400).json({ success: false, message: "Failed to submit contact form" });
    }
  });

  // Verify session
  app.get("/api/session", (req, res) => {
    const sessionId = getSessionFromHeader(req);
    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    const session = sessions.get(sessionId)!;
    res.json({ success: true, user: { id: session.userId, username: session.username } });
  });

  // Get current user profile
  app.get("/api/user/profile", async (req, res) => {
    try {
      const sessionId = getSessionFromHeader(req);
      if (!sessionId || !sessions.has(sessionId)) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }
      
      const session = sessions.get(sessionId)!;
      if (!session.userId) {
        return res.status(401).json({ success: false, message: "Invalid session" });
      }
      
      const user = await storage.getUser(session.userId);
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      
      const { password, ...userWithoutPassword } = user;
      res.json({ success: true, user: { ...userWithoutPassword, profileImage: (user as any).profileImage } });
    } catch (error) {
      console.error("Get profile error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch profile" });
    }
  });

  // Update user profile
  app.patch("/api/user/profile", async (req, res) => {
    try {
      const sessionId = getSessionFromHeader(req);
      if (!sessionId || !sessions.has(sessionId)) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }
      
      const session = sessions.get(sessionId)!;
      if (!session.userId) {
        return res.status(401).json({ success: false, message: "Invalid session" });
      }
      
      const profileData = updateProfileSchema.parse(req.body);
      const updatedUser = await storage.updateUserProfile(session.userId, { ...profileData, profileImage: req.body.profileImage });
      
      if (!updatedUser) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      
      const { password, ...userWithoutPassword } = updatedUser;
      res.json({ success: true, message: "Profile updated", user: { ...userWithoutPassword, profileImage: (updatedUser as any).profileImage } });
    } catch (error) {
      console.error("Update profile error:", error);
      res.status(400).json({ success: false, message: "Failed to update profile" });
    }
  });

  app.get("/api/uploads", async (req, res) => {
    try {
      const uploads = await storage.getAllUploads();
      res.json({ success: true, uploads });
    } catch (error) {
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch uploads" });
    }
  });

  // Serve individual segment images (must come BEFORE the :folder route)
  app.get("/api/segments/image", async (req, res) => {
    try {
      const imagePath = req.query.path as string;

      if (!imagePath) {
        return res
          .status(400)
          .json({ success: false, message: "No image path provided" });
      }

      // Resolve the absolute path from the current working directory
      const resolvedPath = path.join(process.cwd(), imagePath);
      const segmentedOutputDir = path.join(process.cwd(), "segmented_output");
      const uploadsDir = path.join(process.cwd(), "uploads");
      const filesDir = path.join(process.cwd(), "files");

      // Security check: ensure the path is within segmented_output, uploads, or files
      const isInSegmentedOutput = resolvedPath.startsWith(segmentedOutputDir);
      const isInUploads = resolvedPath.startsWith(uploadsDir);
      const isInFiles = resolvedPath.startsWith(filesDir);

      if (!isInSegmentedOutput && !isInUploads && !isInFiles) {
        return res
          .status(403)
          .json({ success: false, message: "Access denied" });
      }

      if (!fs.existsSync(resolvedPath)) {
        return res
          .status(404)
          .json({ success: false, message: "Image not found" });
      }

      // Prevent caching so updated images are always shown
      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, private",
      );
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");

      res.sendFile(resolvedPath);
    } catch (error) {
      console.error("Error serving image:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to serve image" });
    }
  });

  // Get images from a specific segmented folder (must come AFTER the /image route)
  app.get("/api/segments/:folder", async (req, res) => {
    try {
      const folder = req.params.folder;
      const segmentedOutputDir = path.join(process.cwd(), "segmented_output");

      if (!fs.existsSync(segmentedOutputDir)) {
        return res.json([]);
      }

      const images: { path: string; name: string }[] = [];
      const imageExts = [".jpg", ".jpeg", ".png", ".webp"];

      // Look directly in segmented_output/<folder>/ for images
      const folderPath = path.join(segmentedOutputDir, folder);
      if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
        const files = fs.readdirSync(folderPath);
        files.forEach((file) => {
          const ext = path.extname(file).toLowerCase();
          if (imageExts.includes(ext)) {
            // Return relative path for frontend API
            const relativePath = path
              .join("segmented_output", folder, file)
              .replace(/\\/g, "/");
            images.push({
              path: relativePath,
              name: file,
            });
          }
        });
      }

      res.json(images);
    } catch (error) {
      console.error("Error fetching segments:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to fetch segments" });
    }
  });

  // Generate report by running Python scripts sequentially
  app.post("/api/generate-report", async (req, res) => {
    try {
      console.log("[Report Generation] Starting report generation process");

      const pdfPath = path.join(process.cwd(), "Results", "Merged_Result.pdf");

      // Clear existing PDF before generating new one
      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
        console.log("[Report Generation] Cleared existing PDF");
      }

      const scripts = [
        "1_rack_match.py",
        "2_switch_match.py",
        "3_patchpanel_match.py",
        "4_1_conneted_port_match.py",
        "4_port_match.py",
        "5_cable_match.py",
        "6_merge_result.py",
      ];

      const executionLogs: Array<{
        script: string;
        status: "success" | "error";
        stdout: string;
        stderr: string;
        error?: string;
        timestamp: string;
      }> = [];

      // Run each script sequentially
      for (const script of scripts) {
        const scriptPath = path.join(process.cwd(), "python_codes", script);
        // Use the venv Python executable so installed packages are available
        const pythonExe = path.join(process.cwd(), ".venv", "Scripts", "python.exe");
        const command = `"${pythonExe}" "${scriptPath}"`;
        const timestamp = new Date().toISOString();

        console.log(`[Report Generation] Running: ${script}`);

        try {
          const { stdout, stderr } = await execAsync(command);
          console.log(`[${script} Output]:`, stdout);
          if (stderr) {
            console.error(`[${script} Error]:`, stderr);
          }

          executionLogs.push({
            script,
            status: "success",
            stdout: stdout || "",
            stderr: stderr || "",
            timestamp,
          });
        } catch (error: any) {
          console.error(`[Report Generation] Error in ${script}:`, error);

          executionLogs.push({
            script,
            status: "error",
            stdout: error.stdout || "",
            stderr: error.stderr || "",
            error: error.message,
            timestamp,
          });

          throw new Error(`Failed to run ${script}: ${error.message}`);
        }
      }

      // Check if the PDF was generated
      if (!fs.existsSync(pdfPath)) {
        throw new Error("PDF was not generated successfully");
      }

      console.log("[Report Generation] Report generated successfully");

      // Persist a record of the generated report for the user (if authenticated)
      try {
        const sessionId = getSessionFromHeader(req);
        const session = sessionId ? sessions.get(sessionId) : undefined;
        const userId = session?.userId ?? null;
        if (userId) {
          // ensure reports directory exists
          const reportsDir = path.join(process.cwd(), "reports");
          if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

          const userReportsDir = path.join(reportsDir, userId);
          if (!fs.existsSync(userReportsDir)) fs.mkdirSync(userReportsDir, { recursive: true });

          // create a unique filename for this user's report and copy the generated PDF
          const destFilename = `${randomUUID()}.pdf`;
          const destRelative = path.join("reports", userId, destFilename).replace(/\\/g, "/");
          const destAbs = path.join(process.cwd(), destRelative);

          try {
            fs.copyFileSync(pdfPath, destAbs);
          } catch (copyErr) {
            console.error("[Report Generation] Failed to copy PDF to reports folder:", copyErr);
            // still attempt to persist metadata pointing to original PDF as a fallback
          }

          // Attempt to associate the report with the most-recent uploaded image (if available)
          let associatedImage: string | null = null;
          try {
            const uploadsRoot = path.join(process.cwd(), filesDir);
            const allFiles: string[] = [];
            for (const folder of uploadTypeFolders) {
              const folderPath = path.join(uploadsRoot, folder);
              if (fs.existsSync(folderPath)) {
                const filesInFolder = fs.readdirSync(folderPath).map((f) => path.join(folderPath, f));
                filesInFolder.forEach((p) => {
                  try {
                    if (fs.existsSync(p) && fs.statSync(p).isFile()) allFiles.push(p);
                  } catch (e) {}
                });
              }
            }
            if (allFiles.length > 0) {
              // prefer the newest file whose mtime is <= the PDF mtime (so we don't associate a later upload)
              const pdfStat = fs.existsSync(pdfPath) ? fs.statSync(pdfPath) : null;
              const pdfMtime = pdfStat ? pdfStat.mtimeMs : Date.now();

              const candidates = allFiles
                .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
                .filter((x) => x.mtime <= pdfMtime)
                .sort((a, b) => b.mtime - a.mtime);

              let chosen: string | null = null;
              if (candidates.length > 0) {
                chosen = candidates[0].p;
              } else {
                // fallback: choose the newest file overall
                allFiles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
                chosen = allFiles[0];
              }

              if (chosen) {
                associatedImage = path.relative(process.cwd(), chosen).replace(/\\/g, "/");
              }
            }
          } catch (e) {
            console.warn("[Report Generation] Failed to determine associated image:", e);
            associatedImage = null;
          }

          await storage.createReport({
            userId,
            title: `Merged Result ${new Date().toISOString()}`,
            filename: destFilename,
            pdfPath: destRelative,
            processedImage: associatedImage,
          });

          console.log("[Report Generation] Saved report metadata for user", userId, "->", destRelative);
        }
      } catch (err) {
        console.error("[Report Generation] Failed to save report metadata:", err);
      }

      res.json({
        success: true,
        message: "Report generated successfully",
        pdfPath: "Results/Merged_Result.pdf",
        logs: executionLogs,
      });
    } catch (error: any) {
      console.error("[Report Generation] Error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to generate report",
        logs: [],
      });
    }
  });

  // Serve the generated PDF
  app.get("/api/report/pdf", async (req, res) => {
    try {
      const sessionId = getSessionFromHeader(req);
      if (!sessionId || !sessions.has(sessionId)) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }
      const session = sessions.get(sessionId)!;

      // Find the latest report for this user
      const reports = await storage.getUserReports(session.userId!);
      if (!reports || reports.length === 0) {
        return res.status(404).json({ success: false, message: "No reports found" });
      }

      // choose the most recent by createdAt
      reports.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const latest = reports[reports.length - 1];
      const absPath = path.join(process.cwd(), latest.pdfPath);
      if (!fs.existsSync(absPath)) {
        return res.status(404).json({ success: false, message: "PDF file not found" });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${latest.filename || 'report.pdf'}"`);
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(absPath);
    } catch (error) {
      console.error("Error serving PDF:", error);
      res.status(500).json({ success: false, message: "Failed to serve PDF" });
    }
  });

  // Serve a specific report PDF by id (must be authenticated and owner)
  app.get("/api/report/:id/pdf", async (req, res) => {
    try {
      const sessionId = getSessionFromHeader(req);
      if (!sessionId || !sessions.has(sessionId)) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }
      const session = sessions.get(sessionId)!;
      const reportId = req.params.id;
      const report = await storage.getReport(reportId);
      if (!report) return res.status(404).json({ success: false, message: "Report not found" });
      if (report.userId !== session.userId) return res.status(403).json({ success: false, message: "Forbidden" });

      const absPath = path.join(process.cwd(), report.pdfPath);
      if (!fs.existsSync(absPath)) return res.status(404).json({ success: false, message: "PDF file not found" });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${report.filename || 'report.pdf'}"`);
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(absPath);
    } catch (err) {
      console.error("/api/report/:id/pdf error:", err);
      res.status(500).json({ success: false, message: "Failed to serve report" });
    }
  });

  // Handle HEAD requests for PDF (used by react-pdf to check file)
  app.head("/api/report/pdf", async (req, res) => {
    try {
      const sessionId = getSessionFromHeader(req);
      if (!sessionId || !sessions.has(sessionId)) {
        return res.status(401).end();
      }
      const session = sessions.get(sessionId)!;

      const reports = await storage.getUserReports(session.userId!);
      if (!reports || reports.length === 0) {
        return res.status(404).end();
      }

      reports.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const latest = reports[reports.length - 1];
      const absPath = path.join(process.cwd(), latest.pdfPath);
      if (!fs.existsSync(absPath)) return res.status(404).end();

      const stats = fs.statSync(absPath);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", stats.size.toString());
      res.status(200).end();
    } catch (error) {
      console.error("Error checking PDF:", error);
      res.status(500).end();
    }
  });

  // Return history for a user (requires authentication and ownership)
  app.get("/api/history/:uid", async (req, res) => {
    try {
      const sessionId = getSessionFromHeader(req);
      if (!sessionId || !sessions.has(sessionId)) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }
      const session = sessions.get(sessionId)!;
      const uid = req.params.uid;
      if (!uid) return res.status(400).json({ success: false, message: "Missing user id" });
      // enforce that the requesting user can only view their own history
      if (session.userId !== uid) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }

      const reports = await storage.getUserReports(uid);
      res.json({ success: true, reports });
    } catch (err) {
      console.error("/api/history error:", err);
      res.status(500).json({ success: false, message: "Failed to fetch history" });
    }
  });

  // Delete a report (requires authentication and ownership)
  app.delete("/api/reports/:id", async (req, res) => {
    try {
      const sessionId = getSessionFromHeader(req);
      if (!sessionId || !sessions.has(sessionId)) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }
      const session = sessions.get(sessionId)!;
      const reportId = req.params.id;
      if (!reportId) return res.status(400).json({ success: false, message: "Missing report id" });
      // Ensure report exists and belongs to the session user
      const report = await storage.getReport(reportId);
      if (!report) return res.status(404).json({ success: false, message: "Report not found" });
      if (report.userId !== session.userId) return res.status(403).json({ success: false, message: "Forbidden" });

      // attempt to remove file from disk if present
      try {
        const abs = path.join(process.cwd(), report.pdfPath);
        if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
        }
      } catch (e) {
        console.warn("Failed to delete report file from disk:", e);
      }

      const ok = await storage.deleteReport(reportId);
      res.json({ success: ok });
    } catch (err) {
      console.error("/api/reports DELETE error:", err);
      res.status(500).json({ success: false, message: "Failed to delete report" });
    }
  });

  // Get the latest uploaded original image
  app.get("/api/original-image", async (req, res) => {
    try {
      const imageExts = [".jpg", ".jpeg", ".png", ".webp"];
      const requestedImageName = req.query.name as string;

      let targetImage: string | null = null;

      // Check all upload type folders
      for (const uploadType of uploadTypeFolders) {
        const folderPath = path.join(process.cwd(), filesDir, uploadType);
        if (fs.existsSync(folderPath)) {
          const files = fs.readdirSync(folderPath);
          for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (imageExts.includes(ext)) {
              // If a specific image is requested, match it
              if (requestedImageName && file.startsWith(requestedImageName)) {
                targetImage = path.join(folderPath, file);
                break;
              }
              // Otherwise, find the latest image (fallback behavior)
              if (!requestedImageName) {
                const filePath = path.join(folderPath, file);
                const stats = fs.statSync(filePath);
                if (!targetImage) {
                  targetImage = filePath;
                } else {
                  const targetStats = fs.statSync(targetImage);
                  if (stats.mtime > targetStats.mtime) {
                    targetImage = filePath;
                  }
                }
              }
            }
          }
          if (targetImage && requestedImageName) break;
        }
      }

      if (!targetImage) {
        return res
          .status(404)
          .json({ success: false, message: "No original image found" });
      }

      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, private",
      );
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.sendFile(targetImage);
    } catch (error) {
      console.error("Error serving original image:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to serve original image" });
    }
  });

  // Serve demo video
  app.get("/api/demo-video", async (req, res) => {
    try {
      const videoPath = path.join(
        process.cwd(),
        "attached_assets",
        "RackTrack_Video (online-video-cutter.com)_1761815140933.mp4"
      );

      if (!fs.existsSync(videoPath)) {
        return res.status(404).json({ success: false, message: "Demo video not found" });
      }

      const stat = fs.statSync(videoPath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(videoPath, { start, end });
        const head = {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunksize,
          "Content-Type": "video/mp4",
        };
        res.writeHead(206, head);
        file.pipe(res);
      } else {
        const head = {
          "Content-Length": fileSize,
          "Content-Type": "video/mp4",
        };
        res.writeHead(200, head);
        fs.createReadStream(videoPath).pipe(res);
      }
    } catch (error) {
      console.error("Error serving demo video:", error);
      res.status(500).json({ success: false, message: "Failed to serve demo video" });
    }
  });

  // Get component metadata from HTML reports
  app.get("/api/component-metadata/:type", async (req, res) => {
    try {
      const componentType = req.params.type;
      const resultsDir = path.join(process.cwd(), "Results");
      const segmentedOutputDir = path.join(process.cwd(), "segmented_output");

      if (!fs.existsSync(resultsDir)) {
        return res.json({
          success: false,
          message: "Results directory not found",
          data: {},
        });
      }

      let htmlFile = "";

      // Map component type to HTML file
      switch (componentType) {
        case "rack":
          htmlFile = "1_rack_classification.html";
          break;
        case "cables":
          htmlFile = "4_cable_classification.html";
          break;
        case "patch_panel":
          htmlFile = "3_patchpanel_results.html";
          break;
        case "switch":
          htmlFile = "2_switch_match.html";
          break;
        case "connected_port":
          htmlFile = "5_connected_port_classification.html";
          break;
        case "empty_port":
          htmlFile = "5_Ports_Results.html";
          break;
        default:
          return res.json({
            success: false,
            message: "Unknown component type",
            data: {},
          });
      }

      const htmlPath = path.join(resultsDir, htmlFile);

      if (!fs.existsSync(htmlPath)) {
        return res.json({
          success: false,
          message: "Report file not found",
          data: {},
        });
      }

      // Get list of segment images for this component type
      const segmentFolderPath = path.join(segmentedOutputDir, componentType);
      const segmentImages: string[] = [];

      if (
        fs.existsSync(segmentFolderPath) &&
        fs.statSync(segmentFolderPath).isDirectory()
      ) {
        const imageExts = [".jpg", ".jpeg", ".png", ".webp"];
        const files = fs.readdirSync(segmentFolderPath);

        // Filter and collect image files
        for (const file of files) {
          const ext = path.extname(file).toLowerCase();
          if (imageExts.includes(ext)) {
            segmentImages.push(file);
          }
        }

        // Natural sort by numeric suffix: extract numbers and sort numerically
        segmentImages.sort((a, b) => {
          const numA = parseInt(a.match(/_(\d+)\./)?.[1] || "0");
          const numB = parseInt(b.match(/_(\d+)\./)?.[1] || "0");
          return numA - numB;
        });
      }

      const htmlContent = fs.readFileSync(htmlPath, "utf8");
      const $ = cheerio.load(htmlContent);
      const metadataByFilename: Record<string, any> = {};

      // Parse based on component type
      if (componentType === "rack") {
        const rows = $("table tr").toArray();

        for (let i = 1; i < rows.length && i - 1 < segmentImages.length; i++) {
          const $row = $(rows[i]);
          const rackType = $row.find(".rack-type").text().trim();
          const vendor = $row.find(".vendor").text().trim();
          const summaryItems: string[] = [];

          $row.find("ul li").each((_, li) => {
            summaryItems.push($(li).text().trim());
          });

          const filename = segmentImages[i - 1];
          metadataByFilename[filename] = {
            rackType,
            vendor,
            summary: summaryItems,
          };
        }
      } else if (componentType === "cables") {
        const rows = $("table tr").toArray();

        for (let i = 1; i < rows.length && i - 1 < segmentImages.length; i++) {
          const $row = $(rows[i]);
          const cells = $row.find("td").toArray();

          if (cells.length >= 6) {
            const filename = segmentImages[i - 1];
            metadataByFilename[filename] = {
              prediction: $(cells[1]).text().trim(),
              cableType: $(cells[2]).text().trim(),
              usage: $(cells[3]).text().trim(),
              features: $(cells[4]).text().trim(),
              description: $(cells[5]).text().trim(),
            };
          }
        }
      } else if (componentType === "patch_panel") {
        const rows = $("table tr").toArray();

        for (let i = 1; i < rows.length && i - 1 < segmentImages.length; i++) {
          const $row = $(rows[i]);
          const cells = $row.find("td").toArray();

          if (cells.length >= 4) {
            const predictedClass = $(cells[1]).text().trim();
            const description = $(cells[2]).text().trim();
            const similarity = $(cells[3]).text().trim();

            if (predictedClass || description || similarity) {
              const filename = segmentImages[i - 1];
              metadataByFilename[filename] = {
                predictedClass,
                description,
                similarity,
              };
            }
          }
        }
      } else if (componentType === "switch") {
        const rows = $("table tr").toArray();

        for (let i = 1; i < rows.length && i - 1 < segmentImages.length; i++) {
          const $row = $(rows[i]);
          const cells = $row.find("td").toArray();

          if (cells.length >= 4) {
            const predictedClass = $(cells[1]).text().trim();
            const description = $(cells[2]).text().trim();
            const similarity = $(cells[3]).text().trim();

            if (predictedClass || description || similarity) {
              const filename = segmentImages[i - 1];
              metadataByFilename[filename] = {
                predictedClass,
                description,
                similarity,
              };
            }
          }
        }
      } else if (componentType === "connected_port") {
        const rows = $("table tr").toArray();

        for (let i = 1; i < rows.length && i - 1 < segmentImages.length; i++) {
          const $row = $(rows[i]);
          const cells = $row.find("td").toArray();

          if (cells.length >= 8) {
            const cable = $(cells[1]).text().trim();
            const cableTypeFeatures = $(cells[2]).text().trim();
            const cableDescription = $(cells[3]).text().trim();
            const usage = $(cells[4]).text().trim();
            const port = $(cells[5]).text().trim();
            const portDescription = $(cells[6]).text().trim();
            const anotherPortExpected = $(cells[7]).text().trim();

            const filename = segmentImages[i - 1];
            metadataByFilename[filename] = {
              cable,
              cableTypeFeatures,
              cableDescription,
              usage,
              port,
              portDescription,
              anotherPortExpected,
              predictedClass: port, // Set port as the main predicted class for backward compatibility
            };
          }
        }
      } else if (componentType === "empty_port") {
        const rows = $("table tr").toArray();

        for (let i = 1; i < rows.length && i - 1 < segmentImages.length; i++) {
          const $row = $(rows[i]);
          const cells = $row.find("td").toArray();

          if (cells.length >= 4) {
            const predictedClass = $(cells[1]).text().trim();
            const description = $(cells[2]).text().trim();
            const similarity = $(cells[3]).text().trim();

            if (predictedClass || description || similarity) {
              const filename = segmentImages[i - 1];
              metadataByFilename[filename] = {
                predictedClass,
                description,
                similarity,
              };
            }
          }
        }
      }

      res.json({ success: true, data: metadataByFilename });
    } catch (error) {
      console.error("Error parsing component metadata:", error);
      res.status(500).json({
        success: false,
        message: "Failed to parse metadata",
        data: {},
      });
    }
  });

  // Get bounding box coordinates for a specific segment
  app.get("/api/segment-coordinates", async (req, res) => {
    try {
      const segmentPath = req.query.path as string;
      if (!segmentPath) {
        return res.status(400).json({ error: "Segment path is required" });
      }

      const segmentFileName = path.basename(segmentPath);
      let coordinates = null;
      let originalImageName = null;

      // Helper function to extract bbox coordinates
      const extractCoordinates = (
        bbox: number[],
        className: string,
        confidence?: number,
      ) => ({
        x1: bbox[0],
        y1: bbox[1],
        x2: bbox[2],
        y2: bbox[3],
        width: bbox[2] - bbox[0],
        height: bbox[3] - bbox[1],
        confidence: confidence || 1.0,
        class_name: className,
      });

      // Try to find coordinates in any JSON file in OUTPUT_DIR
      const OUTPUT_DIR = path.join(process.cwd(), "segmented_output");
      const jsonFiles = fs
        .readdirSync(OUTPUT_DIR)
        .filter((f) => f.endsWith(".json"));

      for (const jsonFile of jsonFiles) {
        const jsonPath = path.join(OUTPUT_DIR, jsonFile);
        const jsonData = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

        // Map plural category names to singular for display
        const categoryMap: Record<string, string> = {
          switches: "switch",
          patch_panels: "patch panel",
          rack: "rack",
          cables: "cable",
          connected_ports: "connected port",
          empty_ports: "empty port",
        };

        // Handle video format (frames array)
        if (
          jsonData.video_filename &&
          jsonData.frames &&
          Array.isArray(jsonData.frames)
        ) {
          for (const frame of jsonData.frames) {
            const categories = [
              "switches",
              "patch_panels",
              "rack",
              "cables",
              "connected_ports",
              "empty_ports",
            ];

            for (const category of categories) {
              if (frame[category] && Array.isArray(frame[category])) {
                const match = frame[category].find(
                  (item: any) =>
                    item.segmented_filename &&
                    item.segmented_filename === segmentFileName,
                );

                if (
                  match &&
                  match.bbox &&
                  Array.isArray(match.bbox) &&
                  match.bbox.length === 4
                ) {
                  coordinates = extractCoordinates(
                    match.bbox,
                    categoryMap[category] || category,
                    match.confidence,
                  );
                  originalImageName = path.parse(jsonData.video_filename).name;
                  break;
                }
              }
            }
            if (coordinates) break;
          }
        }
        // Handle single image format (has filename property)
        else if (jsonData.filename) {
          const categories = [
            "switches",
            "patch_panels",
            "cables",
            "empty_ports",
            "connected_ports",
          ];

          for (const category of categories) {
            if (jsonData[category] && Array.isArray(jsonData[category])) {
              const match = jsonData[category].find(
                (item: any) =>
                  item.segmented_filename &&
                  item.segmented_filename === segmentFileName,
              );

              if (
                match &&
                match.bbox &&
                Array.isArray(match.bbox) &&
                match.bbox.length === 4
              ) {
                coordinates = extractCoordinates(
                  match.bbox,
                  categoryMap[category] || category,
                  match.confidence,
                );
                originalImageName = jsonData.filename;
                break;
              }
            }
          }

          // Check nested ports inside switches
          if (
            !coordinates &&
            jsonData.switches &&
            Array.isArray(jsonData.switches)
          ) {
            for (const sw of jsonData.switches) {
              // Check the switch itself
              if (sw.segmented_filename === segmentFileName && sw.bbox) {
                coordinates = extractCoordinates(
                  sw.bbox,
                  "switch",
                  sw.confidence,
                );
                originalImageName = jsonData.filename;
                break;
              }

              // Check nested empty ports
              if (sw.empty_ports && Array.isArray(sw.empty_ports)) {
                const portMatch = sw.empty_ports.find(
                  (p: any) => p.segmented_filename === segmentFileName,
                );
                if (portMatch && portMatch.bbox) {
                  coordinates = extractCoordinates(
                    portMatch.bbox,
                    "empty_port",
                  );
                  originalImageName = jsonData.filename;
                  break;
                }
              }

              // Check nested connected ports
              if (sw.connected_ports && Array.isArray(sw.connected_ports)) {
                const portMatch = sw.connected_ports.find(
                  (p: any) => p.segmented_filename === segmentFileName,
                );
                if (portMatch && portMatch.bbox) {
                  coordinates = extractCoordinates(
                    portMatch.bbox,
                    "connected_port",
                  );
                  originalImageName = jsonData.filename;
                  break;
                }
              }
            }
          }

          // Check nested ports inside patch panels
          if (
            !coordinates &&
            jsonData.patch_panels &&
            Array.isArray(jsonData.patch_panels)
          ) {
            for (const pp of jsonData.patch_panels) {
              // Check the patch panel itself
              if (pp.segmented_filename === segmentFileName && pp.bbox) {
                coordinates = extractCoordinates(
                  pp.bbox,
                  "patch_panel",
                  pp.confidence,
                );
                originalImageName = jsonData.filename;
                break;
              }

              // Check nested empty ports
              if (pp.empty_ports && Array.isArray(pp.empty_ports)) {
                const portMatch = pp.empty_ports.find(
                  (p: any) => p.segmented_filename === segmentFileName,
                );
                if (portMatch && portMatch.bbox) {
                  coordinates = extractCoordinates(
                    portMatch.bbox,
                    "empty_port",
                  );
                  originalImageName = jsonData.filename;
                  break;
                }
              }

              // Check nested connected ports
              if (pp.connected_ports && Array.isArray(pp.connected_ports)) {
                const portMatch = pp.connected_ports.find(
                  (p: any) => p.segmented_filename === segmentFileName,
                );
                if (portMatch && portMatch.bbox) {
                  coordinates = extractCoordinates(
                    portMatch.bbox,
                    "connected_port",
                  );
                  originalImageName = jsonData.filename;
                  break;
                }
              }
            }
          }

          // Check rack_bbox
          if (
            !coordinates &&
            jsonData.rack_bbox &&
            jsonData.rack_segmented_filename === segmentFileName
          ) {
            coordinates = extractCoordinates(jsonData.rack_bbox, "rack");
            originalImageName = jsonData.filename;
          }
        }
        // Handle multi-image format (object with image keys)
        else if (typeof jsonData === "object") {
          for (const [imageKey, imageData] of Object.entries(jsonData)) {
            const data = imageData as any;

            if (!data || typeof data !== "object") continue;

            // Check switches with nested ports
            if (data.switches && Array.isArray(data.switches)) {
              for (const sw of data.switches) {
                if (sw.segmented_filename === segmentFileName && sw.bbox) {
                  coordinates = extractCoordinates(
                    sw.bbox,
                    "switch",
                    sw.confidence,
                  );
                  originalImageName = data.filename || imageKey;
                  break;
                }

                // Check nested empty ports
                if (sw.empty_ports) {
                  const portMatch = sw.empty_ports.find(
                    (p: any) => p.segmented_filename === segmentFileName,
                  );
                  if (portMatch && portMatch.bbox) {
                    coordinates = extractCoordinates(
                      portMatch.bbox,
                      "empty_port",
                    );
                    originalImageName = data.filename || imageKey;
                    break;
                  }
                }

                // Check nested connected ports
                if (sw.connected_ports) {
                  const portMatch = sw.connected_ports.find(
                    (p: any) => p.segmented_filename === segmentFileName,
                  );
                  if (portMatch && portMatch.bbox) {
                    coordinates = extractCoordinates(
                      portMatch.bbox,
                      "connected_port",
                    );
                    originalImageName = data.filename || imageKey;
                    break;
                  }
                }
              }
            }

            // Check patch_panels
            if (
              !coordinates &&
              data.patch_panels &&
              Array.isArray(data.patch_panels)
            ) {
              for (const pp of data.patch_panels) {
                if (pp.segmented_filename === segmentFileName && pp.bbox) {
                  coordinates = extractCoordinates(
                    pp.bbox,
                    "patch_panel",
                    pp.confidence,
                  );
                  originalImageName = data.filename || imageKey;
                  break;
                }

                // Check nested ports
                if (pp.empty_ports) {
                  const portMatch = pp.empty_ports.find(
                    (p: any) => p.segmented_filename === segmentFileName,
                  );
                  if (portMatch && portMatch.bbox) {
                    coordinates = extractCoordinates(
                      portMatch.bbox,
                      "empty_port",
                    );
                    originalImageName = data.filename || imageKey;
                    break;
                  }
                }

                if (pp.connected_ports) {
                  const portMatch = pp.connected_ports.find(
                    (p: any) => p.segmented_filename === segmentFileName,
                  );
                  if (portMatch && portMatch.bbox) {
                    coordinates = extractCoordinates(
                      portMatch.bbox,
                      "connected_port",
                    );
                    originalImageName = data.filename || imageKey;
                    break;
                  }
                }
              }
            }

            // Check cables
            if (!coordinates && data.cables && Array.isArray(data.cables)) {
              const cableMatch = data.cables.find(
                (c: any) => c.segmented_filename === segmentFileName,
              );
              if (cableMatch && cableMatch.bbox) {
                coordinates = extractCoordinates(
                  cableMatch.bbox,
                  "cables",
                  cableMatch.confidence,
                );
                originalImageName = data.filename || imageKey;
              }
            }

            // Check rack
            if (
              !coordinates &&
              data.rack_bbox &&
              data.rack_segmented_filename === segmentFileName
            ) {
              coordinates = extractCoordinates(data.rack_bbox, "rack");
              originalImageName = data.filename || imageKey;
            }

            if (coordinates) break;
          }
        }

        if (coordinates) break;
      }

      // If we found coordinates and originalImageName, search for the actual file
      let originalImagePath = null;
      if (coordinates && originalImageName) {
        const fileDirs = [
          path.join(process.cwd(), "files", "single-image"),
          path.join(process.cwd(), "files", "multiple-images"),
          path.join(process.cwd(), "files", "video"),
        ];

        // Search for file matching the originalImageName pattern
        for (const dir of fileDirs) {
          if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            console.log(`[DEBUG] Searching in ${dir} for ${originalImageName}`);
            console.log(`[DEBUG] Files found:`, files);

            const matchingFile = files.find((file) => {
              const nameWithoutExt = path.parse(file).name;
              console.log(
                `[DEBUG] Comparing ${nameWithoutExt} === ${originalImageName}`,
              );
              return (
                nameWithoutExt === originalImageName ||
                file.startsWith(originalImageName)
              );
            });

            if (matchingFile) {
              console.log(`[DEBUG] Found matching file:`, matchingFile);
              // Return relative path for frontend
              const relativePath = path
                .join(
                  path.basename(path.dirname(dir)),
                  path.basename(dir),
                  matchingFile,
                )
                .replace(/\\/g, "/");
              console.log(`[DEBUG] Relative path:`, relativePath);
              originalImagePath = relativePath;
              break;
            }
          }
        }
      }

      res.json({
        coordinates,
        originalImageName: originalImagePath || originalImageName,
      });
    } catch (error: any) {
      console.error("Error fetching segment coordinates:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Chatbot API endpoints
  app.get("/api/chatbot/faqs", (req, res) => {
    try {
      const faqsPath = path.join(process.cwd(), "server", "faqs.json");
      const faqsData = fs.readFileSync(faqsPath, "utf-8");
      const faqs: { question: string; answer: string }[] = JSON.parse(faqsData) as { question: string; answer: string }[];
      res.json(faqs);
    } catch (error) {
      console.error("Error loading FAQs:", error);
      res.status(500).json({ error: "Failed to load FAQs" });
    }
  });

  app.post("/api/chatbot/ask", (req, res) => {
    try {
      const { question } = req.body;
      
      if (!question) {
        return res.status(400).json({ error: "Question is required" });
      }

      const faqsPath = path.join(process.cwd(), "server", "faqs.json");
      const faqsData = fs.readFileSync(faqsPath, "utf-8");
      const faqs = JSON.parse(faqsData);

      // Simple string matching algorithm
      const normalizedQuestion = question.toLowerCase().trim();
      
      // Find best match using keyword matching
      let bestMatch: { question: string; answer: string } | null = null;
      let bestMatchAnswer: string | null = null;
      let highestScore = 0;

      faqs.forEach((faq: any) => {
        const normalizedFaqQuestion = faq.question.toLowerCase();
        
        // Calculate similarity score
        const questionWords = normalizedQuestion.split(/\s+/);
        const faqWords = normalizedFaqQuestion.split(/\s+/);
        
        let score = 0;
        questionWords.forEach((word: string) => {
          if (normalizedFaqQuestion.includes(word)) {
            score++;
          }
        });
        
        // Boost score if questions are very similar
        if (normalizedFaqQuestion.includes(normalizedQuestion) || normalizedQuestion.includes(normalizedFaqQuestion)) {
          score += 10;
        }

        if (score > highestScore) {
          highestScore = score;
          bestMatch = faq as { question: string; answer: string };
          bestMatchAnswer = (faq && faq.answer) ? String(faq.answer) : null;
        }
      });
      const reply = bestMatchAnswer && highestScore > 0 ? bestMatchAnswer : "I'm not fully sure about that. Please ask something related to RackTrack.";
      res.json({ answer: reply });
    } catch (error) {
      console.error("Error processing question:", error);
      res.status(500).json({ error: "Failed to process question" });
    }
  });

  // Debug endpoint for CORS and origin checking
  app.get("/api/debug", (req, res) => {
    try {
      const origin = req.headers.origin || null;
      const raw = (process.env.CORS_ALLOWED || "https://racktrack.ai").split(",").map((o) => o.trim());
      const originAllowed = origin ? raw.includes(origin) : null;
      console.log("[Debug] /api/debug hit - origin:", origin, "allowed:", originAllowed);
      res.json({ success: true, origin, originAllowed, allowedOrigins: raw, headers: req.headers });
    } catch (err) {
      console.error("[Debug] /api/debug error:", err);
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
