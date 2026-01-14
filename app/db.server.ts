import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

const prismaClientInstance = global.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  if (!global.prisma) {
    global.prisma = prismaClientInstance;
  }
}

// Named export as 'db'
export const db = prismaClientInstance;

// Default export
export default prismaClientInstance;
