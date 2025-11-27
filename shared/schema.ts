import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  email: text("email"),
  fullName: text("full_name"),
  profileImage: text("profile_image"),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
});

export const uploads = pgTable("uploads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").notNull(),
  filePath: text("file_path").notNull(),
  uploadType: text("upload_type").notNull(),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
});

export const contacts = pgTable("contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Email delivery metadata for admin resend/monitoring
  emailSent: boolean("email_sent").default(false).notNull(),
  emailAttempts: integer("email_attempts").default(0).notNull(),
  emailLastAttemptAt: timestamp("email_last_attempt_at"),
  emailLastError: text("email_last_error"),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertUploadSchema = createInsertSchema(uploads).omit({
  id: true,
  uploadedAt: true,
});

export const insertContactSchema = createInsertSchema(contacts).omit({
  id: true,
  createdAt: true,
  emailSent: true,
  emailAttempts: true,
  emailLastAttemptAt: true,
  emailLastError: true,
});

export const loginCredentialsSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

export const updateProfileSchema = z.object({
  email: z.string().email("Invalid email address").optional(),
  fullName: z.string().min(1, "Name is required").optional(),
  profileImage: z.string().optional(),
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type LoginCredentials = z.infer<typeof loginCredentialsSchema>;
export type UpdateProfile = z.infer<typeof updateProfileSchema>;
export type InsertUpload = z.infer<typeof insertUploadSchema>;
export type Upload = typeof uploads.$inferSelect;
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contacts.$inferSelect;
