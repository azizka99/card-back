"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteSteamCard = exports.editSteamCard = exports.getScannedCardsByTagId = exports.createScan = void 0;
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const client_s3_1 = require("@aws-sdk/client-s3");
const SteamCard_1 = require("../../models/SteamCard");
const User_1 = require("../../models/User");
const client_1 = require("@prisma/client");
const Tag_1 = require("../../models/Tag");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const Pack_1 = require("../../models/Pack");
const REGION = process.env.AWS_REGION || "eu-central-1";
const BUCKET = process.env.AWS_BUCKET_NAME || "scanaras-steam-bucket";
const s3 = new client_s3_1.S3Client({ region: REGION });
exports.createScan = (0, express_async_handler_1.default)(async (req, res) => {
    const file = req.file;
    const { id, activationCode, barCode, userId, tagId, packId } = req.body;
    let pack = null;
    try {
        console.log("Skana Gelenler", id, activationCode, barCode, userId, tagId, 'packId', packId);
        if (!file) {
            throw new Error("No file Sent");
        }
        // Generate a clean key/path
        const key = `scans/${Date.now()}-${barCode}-${file?.originalname.replace(/\s+/g, "_")}`;
        await s3.send(new client_s3_1.PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype
        }));
        const user = await User_1.User.findUserById(userId);
        const tag = await Tag_1.Tag.findTagById(tagId);
        if (!user) {
            throw new Error(`User with email ${userId} not found`);
        }
        if (!tag) {
            throw new Error(`Tag with with Id ${userId} not found`);
        }
        if (packId) {
            console.log(packId, pack);
            pack = await Pack_1.Pack.findPackById(packId);
            console.log(pack);
            if (!pack) {
                throw new Error(`Pack with Id ${packId} not found`);
            }
            const scannedSteam = new SteamCard_1.SteamCard(id, activationCode, barCode, key, user, new Tag_1.Tag(tag.id, tag.name, tag.created_at), new Pack_1.Pack(pack.start_number, pack.id));
            const send = await SteamCard_1.SteamCard.createSteamCard(scannedSteam);
        }
        else {
            const scannedSteam = new SteamCard_1.SteamCard(id, activationCode, barCode, key, user, new Tag_1.Tag(tag.id, tag.name, tag.created_at));
            const send = await SteamCard_1.SteamCard.createSteamCard(scannedSteam);
        }
        res.json({ error: null, result: "Added!" });
    }
    catch (e) {
        // ✅ Handle Prisma unique constraint violations cleanly
        if ((e instanceof client_1.Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
            e?.code === "P2002") {
            // e.meta?.target often includes the field(s) that violated the constraint
            const fields = e.meta?.target ?? [];
            const fieldList = Array.isArray(fields) ? fields : [fields].filter(Boolean);
            // Build a short, client-friendly message (matches your Flutter detector)
            const msg = fieldList.length === 1
                ? `${fieldList[0]} already scanned`
                : `already scanned`;
            res.status(409).json({
                error: "already scanned",
                details: msg,
                fields: fieldList,
            });
            return;
        }
        console.error(e);
        res.status(500).json({ error: "Upload failed" });
        return;
    }
});
exports.getScannedCardsByTagId = (0, express_async_handler_1.default)(async (req, res) => {
    const { tagId } = req.body;
    if (!tagId) {
        res.json({ result: null, error: "No tagId" });
        return;
    }
    const cards = await SteamCard_1.SteamCard.getSteamCardsByTagId(tagId);
    let signedUrl = null;
    const steamCards = [];
    for (const i in cards) {
        if (cards[i].img_src) {
            signedUrl = await (0, s3_request_presigner_1.getSignedUrl)(s3, new client_s3_1.GetObjectCommand({ Bucket: BUCKET, Key: cards[i].img_src }), { expiresIn: 60 * 10 } // 10 minutes
            );
            steamCards.push({
                activation_code: cards[i].activation_code,
                barcode: cards[i].barcode,
                img_src: signedUrl,
                id: cards[i].id
            });
        }
    }
    res.json({ error: null, result: steamCards });
});
exports.editSteamCard = (0, express_async_handler_1.default)(async (req, res) => {
    const { id, barcode, activation_code } = req.body;
    if (!id || !barcode || !activation_code) {
        res.json({
            error: "there is something missing, id|barcode|activation-cde"
        });
        return;
    }
    const card = await SteamCard_1.SteamCard.editSteamCardById(id, barcode, activation_code);
    res.json({
        error: null,
        result: "edited"
    });
});
exports.deleteSteamCard = (0, express_async_handler_1.default)(async (req, res) => {
    const { id } = req.body;
    if (!id) {
        res.json({
            error: "there is no Id"
        });
        return;
    }
    const card = await SteamCard_1.SteamCard.deleteSteamCardById(id);
    if (!card) {
        res.status(404).json({ error: "Card not found" });
        return;
    }
    const key = card.img_src;
    ;
    if (!key) {
        res.status(404).json({ error: "no img key found" });
        return;
    }
    try {
        await s3.send(new client_s3_1.DeleteObjectCommand({
            Bucket: BUCKET,
            Key: key
        }));
    }
    catch (e) {
        console.error("S3 deletion failed:", e);
    }
    res.json({ ok: true, deletedId: id });
});
