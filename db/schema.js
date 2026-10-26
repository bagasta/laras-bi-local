import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
export const connections = sqliteTable("cloud_connections", {
  ownerId: text("owner_id").primaryKey(),
  encryptedToken: text("encrypted_token").notNull(),
  organization: text("organization").notNull(),
  projectName: text("project_name").notNull(),
  projectRef: text("project_ref"),
  updatedAt: integer("updated_at").notNull(),
});
export const jobs = sqliteTable("provisioning_jobs", {
  ownerId: text("owner_id").primaryKey(),
  phase: text("phase").notNull().default("pending"),
  projectRef: text("project_ref"),
  createAttempted: integer("create_attempted").notNull().default(0),
  leaseOwner: text("lease_owner"),
  leaseUntil: integer("lease_until").notNull().default(0),
  errorCode: text("error_code"),
  schemaHash: text("schema_hash").notNull().default(""),
  updatedAt: integer("updated_at").notNull(),
});
export const aiConnections = sqliteTable("ai_connections", {
  ownerId: text("owner_id").primaryKey(),
  encryptedKey: text("encrypted_key").notNull(),
  model: text("model").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
