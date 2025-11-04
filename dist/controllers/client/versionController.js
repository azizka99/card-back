"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getApiVersion = void 0;
const express_async_handler_1 = __importDefault(require("express-async-handler"));
exports.getApiVersion = (0, express_async_handler_1.default)(async (req, res) => {
    res.json({
        error: null,
        result: "Version 1.0.0"
    });
});
