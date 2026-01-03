import express from "express";
import expressAsyncHandler from "express-async-handler";
import prisma from "../../constants/dbConnection";
import uuid from "uuid";


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

adminRoutes.get("/download", expressAsyncHandler(async (req, res) => {
    // list users that have tags (or all users)
    const users = await prisma.app_user.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" }
    });

    const ean = await prisma.ean.findMany();

    // render same page, but no data yet
    res.render("download", {
        items: [],
        name: { name: "" },      // so your title code doesn't crash
        ean,
        users,
        selectedUserId: "",
        tagsForUser: []          // will be fetched after user selection
    });
}));

adminRoutes.get("/download/:tag_id", expressAsyncHandler(async (req, res) => {
    const tagId = req.params.tag_id;

    const tag = await prisma.tag.findFirst({
        where: { id: tagId },
        select: { id: true, name: true },
    });
    if (!tag) { res.status(404).send("Tag not found"); return }

    // find which user this tag belongs to (based on steam_card)
    const anyRow = await prisma.steam_card.findFirst({
        where: { tag_id: tagId },
        select: { user_id: true },
    });
    const selectedUserId = anyRow ? anyRow.user_id : "";

    const items = await prisma.steam_card.findMany({
        where: { tag_id: tagId },
        select: { barcode: true, activation_code: true },
        orderBy: { created_at: "asc" },
    });

    const users = await prisma.app_user.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
    });

    // tags for that user (distinct tag_ids from steam_card)
    let tagsForUser: any = [];

    if (selectedUserId) {
        const distinct = await prisma.steam_card.findMany({
            where: {
                user_id: selectedUserId,
                tag_id: { not: null },
            },
            select: { tag_id: true },
            distinct: ["tag_id"],
        });

        const tagIds = distinct.map(x => x.tag_id).filter(Boolean);

        tagsForUser = await prisma.tag.findMany({
            where: { id: { in: tagIds as string[] } },
            select: { id: true, name: true },
            orderBy: { created_at: "desc" }, // if you don't have created_at on tag, remove this line
        });
    }

    const ean = await prisma.ean.findMany();

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

adminRoutes.get("/api/user/:user_id/tags", expressAsyncHandler(async (req, res) => {
    const userId = req.params.user_id;

    const distinct = await prisma.steam_card.findMany({
        where: {
            user_id: userId,
            tag_id: { not: null },
        },
        select: { tag_id: true },
        distinct: ["tag_id"],
    });

    const tagIds = distinct.map(x => x.tag_id).filter(Boolean);

    const tags = await prisma.tag.findMany({
        where: { id: { in: tagIds as string[] } },
        select: { id: true, name: true },
        // orderBy: { created_at: "desc" }, // only if exists
    });

    res.json({ success: true, tags });
}));

adminRoutes.get("/monthly-payout", expressAsyncHandler(async (req, res) => {
    const users = await prisma.app_user.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" }
    });

    res.render("monthlyPayout", { users });
}));

adminRoutes.get(
    "/api/monthly-payout",
    expressAsyncHandler(async (req, res) => {
        const userId = String(req.query.userId || "");
        const month = String(req.query.month || ""); // "YYYY-MM"

        if (!userId || !month) {
            res.json({ success: false, message: "Missing userId or month" });
            return
        }

        // 1) group by tag_id, count cards for this user
        const grouped = await prisma.steam_card.groupBy({
            by: ["tag_id"],
            where: { user_id: userId },
            _count: { _all: true },
        });

        // tag_id can be null, so keep only strings
        const tagIds: string[] = grouped
            .map((g) => g.tag_id)
            .filter((x): x is string => typeof x === "string");

        if (tagIds.length === 0) {
            res.json({ success: true, items: [], total: 0 });
            return
        }

        // 2) load tags
        const tags = await prisma.tag.findMany({
            where: { id: { in: tagIds } },
            select: { id: true, name: true },
        });

        // 3) helpers
        function parseTagDate(tagName: any): Date | null {
            if (!tagName) return null;
            const s = String(tagName);
            let m: RegExpMatchArray | null, parts: string[], y: number, mo: number, da: number, dt: Date, raw: string, yy: number;

            // YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD
            m = s.match(/(\d{4}[.\-/]\d{2}[.\-/]\d{2})/);
            if (m) {
                parts = m[1].replace(/[.\/]/g, "-").split("-");
                y = Number(parts[0]); mo = Number(parts[1]); da = Number(parts[2]);
                dt = new Date(y, mo - 1, da);
                if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === da) return dt;
            }

            // DD-MM-YYYY / DD.MM.YYYY / DD/MM/YYYY
            m = s.match(/(\d{2}[.\-/]\d{2}[.\-/]\d{4})/);
            if (m) {
                parts = m[1].replace(/[.\/]/g, "-").split("-");
                da = Number(parts[0]); mo = Number(parts[1]); y = Number(parts[2]);
                dt = new Date(y, mo - 1, da);
                if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === da) return dt;
            }

            // DD-MM-YY / DD.MM.YY / DD/MM/YY => assume 20xx
            m = s.match(/(\d{2}[.\-/]\d{2}[.\-/]\d{2})/);
            if (m) {
                parts = m[1].replace(/[.\/]/g, "-").split("-");
                da = Number(parts[0]); mo = Number(parts[1]); yy = Number(parts[2]);
                y = 2000 + yy;
                dt = new Date(y, mo - 1, da);
                if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === da) return dt;
            }

            // YYYYMMDD
            m = s.match(/(\d{8})/);
            if (m) {
                raw = m[1];
                y = Number(raw.slice(0, 4));
                mo = Number(raw.slice(4, 6));
                da = Number(raw.slice(6, 8));
                dt = new Date(y, mo - 1, da);
                if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === da) return dt;
            }

            return null;
        }

        function monthKey(d: Date): string {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, "0");
            return `${y}-${m}`;
        }

        // Map tagId -> count (typed!)
        const countMap: Record<string, number> = {};

        grouped.forEach((g) => {
            if (typeof g.tag_id === "string") {
                countMap[g.tag_id] = g._count._all;
            }
        });

        // Build items
        type Item = { id: string; name: string; date: string; count: number };
        const items: Item[] = [];

        for (const t of tags) {
            const dt = parseTagDate(t.name);
            if (!dt) continue;
            if (monthKey(dt) !== month) continue;

            items.push({
                id: t.id,
                name: t.name,
                date: dt.toISOString(),
                count: countMap[t.id] ?? 0,
            });
        }

        // Sort by date desc (use getTime)
        items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        const total = items.reduce((sum, x) => sum + x.count, 0);

        res.json({ success: true, items, total });
        return
    })
);

adminRoutes.post("/api/monthly-payout/count", expressAsyncHandler(async (req, res) => {
    const userId = String(req.body.userId || "");
    const tagIds = Array.isArray(req.body.tagIds) ? req.body.tagIds : [];

    if (!userId) { res.json({ success: false, message: "Missing userId" }); return }

    const total = await prisma.steam_card.count({
        where: {
            user_id: userId,
            tag_id: { in: tagIds }
        }
    });

    res.json({ success: true, total });
}));

adminRoutes.get("/magic-links", expressAsyncHandler(async (req, res) => {
    const magicLinks = await prisma.magic_link.findMany({
        orderBy: { created_at: "desc" }
    });

    res.render("magicLinks", { magicLinks });
}));

adminRoutes.post("/api/magic-links", expressAsyncHandler(async (req, res) => {
    const start_at = new Date(req.body.start_at);
    const end_at = new Date(req.body.end_at);

    if (!start_at || !end_at || isNaN(start_at.getTime()) || isNaN(end_at.getTime())) {
        res.status(400).json({ success: false, message: "Invalid start/end" });
        return
    }
    if (end_at <= start_at) {
        res.status(400).json({ success: false, message: "End must be after start" });
        return
    }

    const created = await prisma.magic_link.create({
        data: {
            id: uuid.v4(),
            start_at, end_at
        }
    });

    res.json({ success: true, id: created.id });
}));





export default adminRoutes;