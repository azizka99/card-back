"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const dbConnection_1 = __importDefault(require("../../constants/dbConnection"));
const adminRoutes = express_1.default.Router();
adminRoutes.get("/dashboard", (0, express_async_handler_1.default)(async (req, res) => {
    res.render("adminDashboard.ejs");
}));
adminRoutes.get("/live-feed", (0, express_async_handler_1.default)(async (req, res) => {
    const steam_cards = await dbConnection_1.default.steam_card.findMany({
        include: {
            app_user: true,
            tag: true
        },
        take: 100,
        orderBy: { created_at: "desc" }
    });
    res.render("live-feed", {
        items: steam_cards,
        latestTs: steam_cards[0]?.created_at?.toISOString?.() || null,
    });
}));
exports.default = adminRoutes;
