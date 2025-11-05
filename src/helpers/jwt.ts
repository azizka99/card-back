// src/utils/jwt.ts
import jwt, { Secret, SignOptions } from "jsonwebtoken";

const JWT_SECRET: Secret =
    (process.env.JWT_SECRET as string) || "dev-secret-change-me";

// Make sure this matches the type jwt expects
const JWT_EXPIRES_IN: SignOptions["expiresIn"] =
    (process.env.JWT_EXPIRES_IN as SignOptions["expiresIn"]) || "7d";

export function signToken(userId: string) {
    return jwt.sign({ userId }, JWT_SECRET, {
        expiresIn: JWT_EXPIRES_IN,
    });
}

export function verifyToken(token: string): { userId: string } {
    return jwt.verify(token, JWT_SECRET) as { userId: string };
}