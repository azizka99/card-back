"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkScannedCards = void 0;
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const SteamCard_1 = require("../../models/SteamCard");
exports.checkScannedCards = (0, express_async_handler_1.default)(async (req, res) => {
    const { tag_id } = req.body;
    if (!tag_id) {
        res.status(400).json({ error: "There is no tag_id" });
        return;
    }
    // 🔥 Fire-and-forget background job (no await!)
    setImmediate(async () => {
        try {
            console.log(`[checkScannedCards] Starting background check for tag`, tag_id);
            await SteamCard_1.SteamCard.checkErrorsByTagId(tag_id);
            console.log(`[checkScannedCards] Finished background check for tag`, tag_id);
        }
        catch (err) {
            console.error(`[checkScannedCards] Background check failed for tag ${tag_id}:`, err);
            // optional: write to a log table, send email, etc.
        }
    });
    // 👇 Immediate response to Flutter
    res.json({
        error: null,
        result: `${tag_id} - check started in background`,
    });
});
