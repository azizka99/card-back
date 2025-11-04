"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const clientAuthMiddleWare = (0, express_async_handler_1.default)(async (req, res, next) => {
    const token = req.cookies.token;
    const headerToken = req.headers.token;
    if (token || headerToken) {
        console.log('auth exist');
    }
});
