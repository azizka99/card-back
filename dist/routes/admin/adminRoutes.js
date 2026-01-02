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
    const stats = {
        totalScans: 128430,
        totalScansDiff: "12%",
        activatedCards: 45200,
        activatedCardsDiff: "8%",
        failedScans: 1204,
        failedScansDiff: "2%",
        devicesOnline: 84,
    };
    const topScanners = [
        { initials: "JD", name: "John Doe", location: "Gate A - Entrance", count: 432 },
        { initials: "AS", name: "Anna Smith", location: "Gate B - VIP", count: 390 },
        { initials: "MK", name: "Mike K.", location: "Warehouse Rear", count: 210 },
        { initials: "SL", name: "Sarah Lee", location: "Lobby Front", count: 185 },
        { initials: "DT", name: "David T.", location: "Parking Level 2", count: 140 },
    ];
    // Optional chart data (7 days)
    const chartLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const chartPoints = [1200, 1900, 1500, 2200, 1800, 900, 1100];
    const tags = await dbConnection_1.default.tag.findMany({
        where: {
            is_activated: false
        },
        include: { app_user: true }, // or user relation you have
        orderBy: { created_at: "desc" },
        take: 100,
    });
    res.render("adminDashboard.ejs", {
        activePage: "dashboard",
        stats,
        topScanners,
        chartLabels,
        chartPoints,
        tags
    });
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
        activePage: "live-feed",
    });
}));
adminRoutes.get("/download:tag_id", (0, express_async_handler_1.default)(async (req, res) => {
    const items = await dbConnection_1.default.steam_card.findMany({
        where: {
            tag_id: req.params.tag_id
        },
        select: {
            barcode: true,
            activation_code: true
        }
    });
    if (!items) {
        res.status(404).send("Not Found");
    }
    res.render("download", { items });
}));
exports.default = adminRoutes;
