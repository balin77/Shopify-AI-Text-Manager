import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

const prismaClient = global.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  if (!global.prisma) {
    global.prisma = prismaClient;
  }
}

// Export as named export
const db = prismaClient;
export { db };

// Export as default
export default prismaClient;
