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
        res.json({ error: "There is no tag_id" });
        return;
    }
    await SteamCard_1.SteamCard.checkErrorsByTagId(tag_id);
    res.json({ error: null, result: `${tag_id} - is Checked` });
});
