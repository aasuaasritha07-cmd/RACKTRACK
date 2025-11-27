import { type User, type InsertUser, type LoginCredentials, type Upload, type InsertUpload, type Contact, type InsertContact, type UpdateProfile } from "@shared/schema";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import bcrypt from "bcryptjs";

export interface Report {
  id: string;
  userId: string;
  title: string;
  filename: string;
  pdfPath: string;
  processedImage?: string | null;
  createdAt: string;
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUserProfile(userId: string, profile: UpdateProfile): Promise<User | undefined>;
  validateCredentials(credentials: LoginCredentials): Promise<boolean>;
  createUpload(upload: InsertUpload): Promise<Upload>;
  getAllUploads(): Promise<Upload[]>;
  getUpload(id: string): Promise<Upload | undefined>;
  // report methods
  createReport(report: Omit<Report, "id" | "createdAt">): Promise<Report>;
  getUserReports(userId: string): Promise<Report[]>;
  deleteReport(reportId: string): Promise<boolean>;
  getReport(reportId: string): Promise<Report | undefined>;
  // contact methods
  createContact(contact: InsertContact): Promise<Contact>;
  getAllContacts(): Promise<Contact[]>;
}

const DATA_DIR = path.join(process.cwd(), "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");

function ensureDataDir() {
  return fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    return defaultValue;
  }
}

async function writeJsonFile(filePath: string, data: unknown) {
  await ensureDataDir();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export class FileStorage implements IStorage {
  private users: Map<string, User> = new Map();
  private uploads: Map<string, Upload> = new Map();
  private reports: Map<string, Report> = new Map();
  private contacts: Map<string, Contact> = new Map();

  constructor() {
    // load files async but don't block construction
    this.load().catch((e) => console.error("Failed to load storage files:", e));
  }

  private async load() {
    await ensureDataDir();
    const usersArr = await readJsonFile<User[]>(USERS_FILE, []);
    usersArr.forEach((u) => this.users.set(u.id, u));

    const reportsArr = await readJsonFile<Report[]>(REPORTS_FILE, []);
    reportsArr.forEach((r) => this.reports.set(r.id, r));

    const contactsArr = await readJsonFile<Contact[]>(CONTACTS_FILE, []);
    contactsArr.forEach((c) => this.contacts.set(c.id, c));
  }

  private async persistUsers() {
    await writeJsonFile(USERS_FILE, Array.from(this.users.values()));
  }

  private async persistReports() {
    await writeJsonFile(REPORTS_FILE, Array.from(this.reports.values()));
  }

  private async persistContacts() {
    await writeJsonFile(CONTACTS_FILE, Array.from(this.contacts.values()));
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find((u) => u.username === username);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    // Hash password before storing
    const plain = (insertUser as any).password as string | undefined;
    const hashed = plain ? await bcrypt.hash(plain, 10) : undefined;
    const joinedAt = new Date();
    const user: User = { ...(insertUser as any), id, password: hashed, joinedAt } as any;
    this.users.set(id, user);
    await this.persistUsers();
    return user;
  }

  async updateUserProfile(userId: string, profile: UpdateProfile & { profileImage?: string }): Promise<User | undefined> {
    const user = this.users.get(userId);
    if (!user) return undefined;
    
    const updatedUser: User = {
      ...user,
      email: profile.email !== undefined ? profile.email : user.email,
      fullName: profile.fullName !== undefined ? profile.fullName : user.fullName,
      profileImage: (profile as any).profileImage !== undefined ? (profile as any).profileImage : (user as any).profileImage,
    } as User;
    
    this.users.set(userId, updatedUser);
    await this.persistUsers();
    return updatedUser;
  }

  async validateCredentials(credentials: LoginCredentials): Promise<boolean> {
    const user = await this.getUserByUsername(credentials.username);
    if (!user) return false;
    const stored = (user.password || "") as string;
    const candidate = credentials.password;

    // If stored password looks like a bcrypt hash, compare with bcrypt
    if (stored.startsWith("$2")) {
      return await bcrypt.compare(candidate, stored);
    }

    // Fallback: legacy plaintext password
    if (stored === candidate) {
      // upgrade: hash the plaintext password and persist
      try {
        const newHash = await bcrypt.hash(candidate, 10);
        const updatedUser = { ...user, password: newHash } as User;
        this.users.set(user.id, updatedUser);
        await this.persistUsers();
      } catch (e) {
        // ignore persistence errors
      }
      return true;
    }

    return false;
  }

  async createUpload(insertUpload: InsertUpload): Promise<Upload> {
    const id = randomUUID();
    const upload: Upload = { ...insertUpload, id, uploadedAt: new Date() };
    this.uploads.set(id, upload);
    return upload;
  }

  async getAllUploads(): Promise<Upload[]> {
    return Array.from(this.uploads.values());
  }

  async getUpload(id: string): Promise<Upload | undefined> {
    return this.uploads.get(id);
  }

  async createReport(report: Omit<Report, "id" | "createdAt">): Promise<Report> {
    // Normalize paths for comparison
    const normalize = (p?: string | null) => {
      if (!p) return p;
      return p.replace(/\\/g, "/").replace(/^[\.\/]+/, "");
    };

    const incomingProcessed = normalize(report.processedImage || null) as string | null;
    const incomingPdf = normalize(report.pdfPath || null) as string | null;

    // Try to find existing report for this user+processedImage (preferred)
    let existingEntry: Report | undefined;
    if (incomingProcessed) {
      existingEntry = Array.from(this.reports.values()).find(
        (r) => r.userId === report.userId && normalize(r.processedImage || null) === incomingProcessed,
      );
    }

    // Fallback: match by pdfPath
    if (!existingEntry && incomingPdf) {
      existingEntry = Array.from(this.reports.values()).find(
        (r) => r.userId === report.userId && normalize(r.pdfPath) === incomingPdf,
      );
    }

    // Always create a new report entry. Previously we updated an existing
    // entry when a matching `processedImage` or `pdfPath` was found which
    // caused older reports to be overwritten with the latest PDF. For
    // history/record-keeping we want each generated report to remain
    // immutable, so we always create a new record here.

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const r: Report = { ...report, id, createdAt } as Report;
    this.reports.set(id, r);
    await this.persistReports();
    if (!r.processedImage) {
      console.warn(`[storage] createReport created report ${r.id} without processedImage for user ${r.userId}`);
    }
    return r;
  }

  async getUserReports(userId: string): Promise<Report[]> {
    return Array.from(this.reports.values()).filter((r) => r.userId === userId);
  }

  async deleteReport(reportId: string): Promise<boolean> {
    const existed = this.reports.delete(reportId);
    if (existed) await this.persistReports();
    return existed;
  }

  async getReport(reportId: string): Promise<Report | undefined> {
    return this.reports.get(reportId);
  }

  async createContact(insertContact: InsertContact): Promise<Contact> {
    const id = randomUUID();
    const createdAt = new Date();
    const contact: Contact = {
      ...insertContact,
      id,
      createdAt,
      emailSent: false,
      emailAttempts: 0,
      emailLastAttemptAt: undefined as any,
      emailLastError: undefined as any,
    };
    this.contacts.set(id, contact);
    await this.persistContacts();
    return contact;
  }

  async getAllContacts(): Promise<Contact[]> {
    return Array.from(this.contacts.values());
  }

  async getContact(id: string): Promise<Contact | undefined> {
    return this.contacts.get(id);
  }

  async updateContact(id: string, changes: Partial<Contact>): Promise<Contact | undefined> {
    const existing = this.contacts.get(id);
    if (!existing) return undefined;
    const updated: Contact = { ...existing, ...changes } as Contact;
    this.contacts.set(id, updated);
    await this.persistContacts();
    return updated;
  }
}

export const storage = new FileStorage();
