"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clientAuthMiddleWare = void 0;
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const jwt_1 = require("../helpers/jwt");
exports.clientAuthMiddleWare = (0, express_async_handler_1.default)(async (req, res, next) => {
    const headerToken = req.headers.authorization;
    if (!headerToken) {
        res.json({ result: null, error: "No token" });
        return;
    }
    const token = headerToken?.split(" ")[1];
    if (!token) {
        res.status(401).json({ error: "No token" });
        return;
    }
    const payload = (0, jwt_1.verifyToken)(token);
    req.body.userid = payload.userId;
    next();
});
