"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTagsByUserId = exports.createTag = void 0;
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const Tag_1 = require("../../models/Tag");
exports.createTag = (0, express_async_handler_1.default)(async (req, res) => {
    const { id, name, created_at } = req.body;
    // Validate input
    if (!id || !name) {
        res.status(400);
        throw new Error("Missing id or name");
    }
    // If created_at is not valid, fall back to now
    const safeCreatedAt = !isNaN(new Date(created_at).getTime())
        ? new Date(created_at)
        : new Date();
    const tag = new Tag_1.Tag(id, name, safeCreatedAt);
    // 👇 await this line
    const result = await Tag_1.Tag.createTag(tag);
    res.json({
        error: null,
        result: "created",
    });
});
exports.getTagsByUserId = (0, express_async_handler_1.default)(async (req, res) => {
    const { userid } = req.body;
    if (!userid) {
        res.status(400);
        throw new Error("Missing id");
    }
    const tags = await Tag_1.Tag.findTagByUserId(userid);
    res.json({
        errur: null,
        result: tags
    });
});
