import express from "express";
import expressAsyncHandler from "express-async-handler";
import prisma from "../../constants/dbConnection";


const adminRoutes = express.Router();


adminRoutes.get("/dashboard", expressAsyncHandler(async (req, res) => {
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

    const tags = await prisma.tag.findMany({
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


adminRoutes.get("/live-feed", expressAsyncHandler(async (req, res) => {
    const steam_cards = await prisma.steam_card.findMany({
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





export default adminRoutes;