"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = void 0;
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const User_1 = require("../../models/User");
exports.login = (0, express_async_handler_1.default)(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        res.status(400);
        throw new Error("Missing email or password");
    }
    const user = await User_1.User.findUserByEmail(email);
    if (!user) {
        res.json({ result: null, error: "There is email or password is wrong" });
        return;
    }
    if (!user.getUser().password === password) {
        res.json({ result: null, error: "There is email or password is wrong" });
        return;
    }
    const token = User_1.User.signInUser(user.getUser().id);
    res.json({
        error: null,
        result: { token, userid: user.getUser().id }
    });
});
