"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkPack = exports.createPack = void 0;
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const Pack_1 = require("../../models/Pack");
exports.createPack = (0, express_async_handler_1.default)(async (req, res) => {
    const { id, number } = req.body;
    if (!id || !number) {
        res.json({ error: "no id or number" });
        return;
    }
    const pack = await Pack_1.Pack.createPack(new Pack_1.Pack(number, id));
    res.json({ result: { id: pack?.id } });
});
exports.checkPack = (0, express_async_handler_1.default)(async (req, res) => {
    const { id } = req.body;
    if (!id) {
        res.json({ error: "no id or number" });
        return;
    }
    const pack = await Pack_1.Pack.findPackById(id);
    if (!pack) {
        res.json({ error: `Couldn't find a pack by this ${id} Id ` });
    }
    const checked = await Pack_1.Pack.checkPack(new Pack_1.Pack(pack?.id, pack?.start_number));
    res.json({
        result: { checked }
    });
});
