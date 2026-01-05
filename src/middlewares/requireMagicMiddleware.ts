import type { Request, Response, NextFunction } from "express";
import prisma from "../constants/dbConnection";

export async function requireMagic(req: Request, res: Response, next: NextFunction) {
    try {
        const magicId = req.params.magic_id;

        const magic = await prisma.magic_link.findUnique({
            where: { id: magicId },
            select: {
                id: true,
                start_at: true,
                end_at: true,
            },
        });

        if (!magic) return res.status(404).send("Magic link not found.");

        const now = new Date();

        // Time window checks
        if (magic.start_at && now < magic.start_at) {
            return res.status(403).send("Magic link is not active yet.");
        }
        if (magic.end_at && now > magic.end_at) {
            return res.status(403).send("Magic link expired.");
        }

        // attach to request if you need it later
        (req as any).magic = magic;

        return next();
    } catch (e) {
        console.error(e);
        return res.status(500).send("Server error.");
    }
}