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
adminRoutes.get("/download", (0, express_async_handler_1.default)(async (req, res) => {
    // list users that have tags (or all users)
    const users = await dbConnection_1.default.app_user.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" }
    });
    const ean = await dbConnection_1.default.ean.findMany();
    // render same page, but no data yet
    res.render("download", {
        items: [],
        name: { name: "" }, // so your title code doesn't crash
        ean,
        users,
        selectedUserId: "",
        tagsForUser: [] // will be fetched after user selection
    });
}));
adminRoutes.get("/download/:tag_id", (0, express_async_handler_1.default)(async (req, res) => {
    const tagId = req.params.tag_id;
    const tag = await dbConnection_1.default.tag.findFirst({
        where: { id: tagId },
        select: { id: true, name: true },
    });
    if (!tag) {
        res.status(404).send("Tag not found");
        return;
    }
    // find which user this tag belongs to (based on steam_card)
    const anyRow = await dbConnection_1.default.steam_card.findFirst({
        where: { tag_id: tagId },
        select: { user_id: true },
    });
    const selectedUserId = anyRow ? anyRow.user_id : "";
    const items = await dbConnection_1.default.steam_card.findMany({
        where: { tag_id: tagId },
        select: { barcode: true, activation_code: true },
        orderBy: { created_at: "asc" },
    });
    const users = await dbConnection_1.default.app_user.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
    });
    // tags for that user (distinct tag_ids from steam_card)
    let tagsForUser = [];
    if (selectedUserId) {
        const distinct = await dbConnection_1.default.steam_card.findMany({
            where: {
                user_id: selectedUserId,
                tag_id: { not: null },
            },
            select: { tag_id: true },
            distinct: ["tag_id"],
        });
        const tagIds = distinct.map(x => x.tag_id).filter(Boolean);
        tagsForUser = await dbConnection_1.default.tag.findMany({
            where: { id: { in: tagIds } },
            select: { id: true, name: true },
            orderBy: { created_at: "desc" }, // if you don't have created_at on tag, remove this line
        });
    }
    const ean = await dbConnection_1.default.ean.findMany();
    res.render("download", {
        items,
        name: { name: tag.name },
        ean,
        users,
        selectedUserId,
        tagsForUser,
        selectedTagId: tagId,
    });
}));
adminRoutes.get("/api/user/:user_id/tags", (0, express_async_handler_1.default)(async (req, res) => {
    const userId = req.params.user_id;
    const distinct = await dbConnection_1.default.steam_card.findMany({
        where: {
            user_id: userId,
            tag_id: { not: null },
        },
        select: { tag_id: true },
        distinct: ["tag_id"],
    });
    const tagIds = distinct.map(x => x.tag_id).filter(Boolean);
    const tags = await dbConnection_1.default.tag.findMany({
        where: { id: { in: tagIds } },
        select: { id: true, name: true },
        // orderBy: { created_at: "desc" }, // only if exists
    });
    res.json({ success: true, tags });
}));
exports.default = adminRoutes;
