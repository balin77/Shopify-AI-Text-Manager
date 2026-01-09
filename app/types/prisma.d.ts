// Prisma type declarations
import type { PrismaClient } from "@prisma/client";

declare module "../db.server" {
  export const db: PrismaClient;
  export default db;
}
