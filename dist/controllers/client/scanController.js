"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createScan = void 0;
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const client_s3_1 = require("@aws-sdk/client-s3");
const SteamCard_1 = require("../../models/SteamCard");
const User_1 = require("../../models/User");
const REGION = process.env.AWS_REGION || "eu-central-1";
const BUCKET = process.env.AWS_BUCKET_NAME || "scanaras-steam-bucket";
const s3 = new client_s3_1.S3Client({ region: REGION });
exports.createScan = (0, express_async_handler_1.default)(async (req, res) => {
    const file = req.file;
    const { id, activationCode, barCode } = req.body;
    try {
        if (!file) {
            throw new Error("No file Sent");
        }
        // Generate a clean key/path
        const key = `scans/${Date.now()}-${file?.originalname.replace(/\s+/g, "_")}`;
        await s3.send(new client_s3_1.PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype
        }));
        const user = await User_1.User.findUserByEmail("azizka.ibragimov@gmail.com");
        const scannedSteam = new SteamCard_1.SteamCard(id, activationCode, barCode, key, user);
        const send = await SteamCard_1.SteamCard.createSteamCard(scannedSteam);
        res.json({ error: null, result: "Added!" });
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: "Upload failed" });
    }
});
