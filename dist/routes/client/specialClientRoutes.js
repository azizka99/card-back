"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/client/specialClientRoutes.ts
const express_1 = __importDefault(require("express"));
const dbConnection_1 = __importDefault(require("../../constants/dbConnection"));
const multer_1 = __importDefault(require("multer"));
const client_s3_1 = require("@aws-sdk/client-s3");
const User_1 = require("../../models/User");
const Tag_1 = require("../../models/Tag");
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const special_client = express_1.default.Router();
const REGION = process.env.AWS_REGION || "eu-central-1";
const BUCKET = process.env.AWS_BUCKET_NAME || "scanaras-steam-bucket";
const s3 = new client_s3_1.S3Client({ region: REGION });
// ---- Middleware to protect special-client pages ----
function requireSpecialClientAuth(req, res, next) {
    if (req.session?.specialClientAuthed)
        return next();
    return res.redirect("/special-client/login");
}
// ---- GET /special-client/login ----
special_client.get("/login", async (req, res) => {
    res.render("special-client/login", { error: null });
});
// ---- POST /special-client/login ----
special_client.post("/login", async (req, res) => {
    const { email, password } = req.body;
    if (email === "e.kilinc36@gmail.com" && password === "erdincABI$$669966$$") {
        req.session.specialClientAuthed = true;
        req.session.specialClientUserId = "d923c912-602d-4b93-9041-7b9a5c246b22";
        return res.redirect("/special-client/upload");
    }
    else if (email === "ik@arascom.de" && password === "ikABIIBO$$6669888222$$") {
        req.session.specialClientAuthed = true;
        req.session.specialClientUserId = "b2e6e19d-64b8-4b6a-a6e7-92f18cfcecf2";
        return res.redirect("/special-client/upload");
    }
    return res
        .status(401)
        .render("special-client/login", { error: "Invalid credentials" });
});
// ---- POST /special-client/logout ----
special_client.post("/logout", async (req, res) => {
    req.session.specialClientAuthed = false;
    return res.redirect("/special-client/login");
});
// ---- PROTECTED PAGE (later will be big upload page) ----
special_client.get("/upload", requireSpecialClientAuth, async (req, res) => {
    const userId = req.session.specialClientUserId;
    const tags = await dbConnection_1.default.tag.findMany({
        where: {
            userId
        }
    });
    res.render("special-client/upload", { tags, userId });
});
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
special_client.post("/upload-files", requireSpecialClientAuth, upload.array("files"), async (req, res) => {
    const tagId = req.body.tagId;
    const userId = req.session.specialClientUserId;
    const files = req.files;
    if (!tagId) {
        return res.status(400).json({ error: "Missing tagId" });
    }
    if (!userId) {
        return res.status(400).json({ error: "Missing userId in session" });
    }
    if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
    }
    const results = [];
    // 🔹 Fetch user + tag ONCE per request (not per file)
    const user = await User_1.User.findUserById(userId);
    if (!user) {
        return res
            .status(400)
            .json({ error: `User with id ${userId} not found` });
    }
    const tag = await Tag_1.Tag.findTagById(tagId);
    if (!tag) {
        return res
            .status(400)
            .json({ error: `Tag with id ${tagId} not found` });
    }
    for (const file of files) {
        const original = file.originalname.trim();
        const normalized = original
            .replace(/[‐-‒–—−]/g, "-") // all dash variants -> "-"
            .replace(/[＿﹍﹎]/g, "_");
        const m = normalized.match(/^(\d{16})_(.+?)\.(jpg|jpeg|png)$/i);
        if (!m) {
            results.push({
                name: original,
                ok: false,
                error: "Filename must be 16DIGITBARCODE_ACTIVATIONCODE.jpg (use '_' and normal '-')",
            });
            continue;
        }
        const name = m[0];
        try {
            // 🔹 Safer filename parsing
            // Expect: BARCODE_ACTIVATIONCODE.ext
            // const parts = name.split("_");
            // if (parts.length < 2) {
            //     results.push({
            //         name,
            //         ok: false,
            //         error: "Filename must be BARCODE_ACTIVATIONCODE.ext",
            //     });
            //     continue;
            // }
            // const barcodePart = parts[0].trim();
            // const activationWithExt = parts.slice(1).join("_").trim(); // just in case of extra '_'s
            const barcodePart = m[1];
            const activationPart = m[2];
            console.log("original:", original);
            console.log("normalized:", normalized);
            console.log("barcode:", barcodePart);
            console.log("activation:", activationPart);
            // const activationPart = activationWithExt.replace(
            //     /\.(jpg|jpeg|png)$/i,
            //     ""
            // );
            if (!barcodePart || !activationPart) {
                results.push({
                    name,
                    ok: false,
                    error: "Could not parse barcode/activation from filename",
                });
                continue;
            }
            // 🔹 S3 key: make it truly unique (timestamp + uuid)
            const safeOriginalName = file.originalname.replace(/\s+/g, "_");
            const key = `scans/${Date.now()}-${(0, crypto_1.randomUUID)()}-${barcodePart}-${safeOriginalName}`;
            await s3.send(new client_s3_1.PutObjectCommand({
                Bucket: BUCKET,
                Key: key,
                Body: file.buffer,
                ContentType: file.mimetype,
            }));
            // 🔹 Create domain objects
            // const tagEntity = new Tag(tag.id, tag.name, tag.created_at);
            // const steamCard = new SteamCard(
            //     randomUUID(),
            //     activationPart,
            //     barcodePart,
            //     key,
            //     user,
            //     tagEntity
            // );
            // await SteamCard.createSteamCard(steamCard);
            results.push({ name, ok: true });
        }
        catch (e) {
            // default message
            let msg = "Unknown error";
            // Prisma unique constraint
            if ((e instanceof client_1.Prisma.PrismaClientKnownRequestError &&
                e.code === "P2002") ||
                e?.code === "P2002") {
                const fields = e.meta?.target ?? [];
                const fieldList = Array.isArray(fields)
                    ? fields
                    : [fields].filter(Boolean);
                msg =
                    fieldList.length === 1
                        ? `${fieldList[0]} already scanned`
                        : `already scanned`;
                console.error("Duplicate scan error for file", name, e);
            }
            else {
                msg = e?.message || "Unknown error";
                console.error("Error handling file", name, e);
            }
            results.push({
                name,
                ok: false,
                error: msg,
            });
        }
    }
    return res.json({ results });
});
exports.default = special_client;
