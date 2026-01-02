"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const adminRoutes = express_1.default.Router();
adminRoutes.get("/dashboard", (0, express_async_handler_1.default)(async (req, res) => {
    res.render("adminDashboard.ejs");
}));
exports.default = adminRoutes;
