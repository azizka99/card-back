"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireMagic = requireMagic;
const dbConnection_1 = __importDefault(require("../constants/dbConnection"));
async function requireMagic(req, res, next) {
    try {
        const magicId = req.params.magic_id;
        const magic = await dbConnection_1.default.magic_link.findUnique({
            where: { id: magicId },
            select: {
                id: true,
                start_at: true,
                end_at: true,
            },
        });
        if (!magic)
            return res.status(404).send("Magic link not found.");
        const now = new Date();
        // Time window checks
        if (magic.start_at && now < magic.start_at) {
            return res.status(403).send("Magic link is not active yet.");
        }
        if (magic.end_at && now > magic.end_at) {
            return res.status(403).send("Magic link expired.");
        }
        // attach to request if you need it later
        req.magic = magic;
        return next();
    }
    catch (e) {
        console.error(e);
        return res.status(500).send("Server error.");
    }
}
