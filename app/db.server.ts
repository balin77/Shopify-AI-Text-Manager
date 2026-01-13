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

export const db = prismaClient;
export default prismaClient;
