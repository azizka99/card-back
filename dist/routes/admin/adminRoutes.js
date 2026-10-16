"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const dbConnection_1 = __importDefault(require("../../constants/dbConnection"));
const uuid_1 = __importDefault(require("uuid"));
const activationRunner_1 = require("../../services/activationRunner");
const activationReport_1 = require("../../services/activationReport");
const packCheck_1 = require("../../services/packCheck");
const barcodeCorrection_1 = require("../../services/barcodeCorrection");
const adminRoutes = express_1.default.Router();
// Prisma's `distinct` loads every card of the user and dedupes in Node (~280k rows);
// SQL DISTINCT uses steam_card_user_tag_idx instead.
async function distinctTagIdsOfUser(userId) {
    const rows = await dbConnection_1.default.$queryRaw `
        SELECT DISTINCT tag_id FROM steam_card WHERE user_id = ${userId}::uuid AND tag_id IS NOT NULL`;
    return rows.map((r) => r.tag_id);
}
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
    const activation = await (0, activationRunner_1.getActivationOverview)();
    res.render("adminDashboard.ejs", {
        activation,
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
        select: { id: true, name: true, is_activated: true },
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
        select: { id: true, barcode: true, activation_code: true },
        orderBy: { created_at: "asc" },
    });
    const users = await dbConnection_1.default.app_user.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
    });
    // tags for that user (distinct tag_ids from steam_card)
    let tagsForUser = [];
    if (selectedUserId) {
        const tagIds = await distinctTagIdsOfUser(selectedUserId);
        tagsForUser = await dbConnection_1.default.tag.findMany({
            where: { id: { in: tagIds } },
            select: { id: true, name: true },
            orderBy: { created_at: "desc" }, // if you don't have created_at on tag, remove this line
        });
    }
    const ean = await dbConnection_1.default.ean.findMany();
    const latestJobId = await (0, activationRunner_1.getLatestJobId)(tagId);
    const activationJob = latestJobId ? await (0, activationRunner_1.getJobSnapshot)(latestJobId) : null;
    res.render("download", {
        items,
        name: { name: tag.name },
        ean,
        users,
        selectedUserId,
        tagsForUser,
        selectedTagId: tagId,
        activationJob,
        allowedAmounts: activationRunner_1.ALLOWED_AMOUNTS,
    });
}));
// ---------- activation jobs ----------
function sendActivationError(res, err) {
    if (err instanceof activationRunner_1.ActivationError) {
        res.status(err.httpStatus).json({ success: false, message: err.message });
        return;
    }
    throw err;
}
/** "" / missing -> null, otherwise a number (NaN fails the amount check later) */
function optionalNumber(v) {
    return v === undefined || v === null || v === "" ? null : Number(v);
}
function optionalString(v) {
    return v === undefined || v === null || v === "" ? null : String(v);
}
function parseOptionalDate(v) {
    if (v === undefined || v === null || v === "")
        return undefined;
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d;
}
adminRoutes.post("/api/activation-jobs", (0, express_async_handler_1.default)(async (req, res) => {
    const { tagId, eanId } = req.body;
    const amount = Number(req.body.amount);
    const finishAt = parseOptionalDate(req.body.finishAt); // ISO string from the browser
    if (!tagId || !eanId || !finishAt) {
        res.status(400).json({ success: false, message: "Missing or invalid tagId, eanId or finishAt" });
        return;
    }
    try {
        const jobId = await (0, activationRunner_1.startJob)({
            tagId, eanId, amount, finishAt,
            fallbackEanId: optionalString(req.body.fallbackEanId),
            fallbackAmount: optionalNumber(req.body.fallbackAmount),
        });
        res.json({ success: true, jobId });
    }
    catch (err) {
        sendActivationError(res, err);
    }
}));
adminRoutes.get("/api/activation-jobs/:id", (0, express_async_handler_1.default)(async (req, res) => {
    const snapshot = await (0, activationRunner_1.getJobSnapshot)(req.params.id);
    if (!snapshot) {
        res.status(404).json({ success: false, message: "Job not found" });
        return;
    }
    res.json({ success: true, ...snapshot });
}));
// Server-Sent Events: "job" = summary/counts, "item" = one card changed
adminRoutes.get("/api/activation-jobs/:id/stream", (req, res) => {
    const jobId = req.params.id;
    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // disable nginx buffering
    });
    res.flushHeaders();
    const send = (event) => (data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onJob = send("job");
    const onItem = send("item");
    activationRunner_1.activationEvents.on(`job:${jobId}`, onJob);
    activationRunner_1.activationEvents.on(`item:${jobId}`, onItem);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
        clearInterval(ping);
        activationRunner_1.activationEvents.off(`job:${jobId}`, onJob);
        activationRunner_1.activationEvents.off(`item:${jobId}`, onItem);
    });
});
adminRoutes.post("/api/activation-jobs/:id/cancel", (0, express_async_handler_1.default)(async (req, res) => {
    try {
        await (0, activationRunner_1.cancelJob)(req.params.id);
        res.json({ success: true });
    }
    catch (err) {
        sendActivationError(res, err);
    }
}));
adminRoutes.get("/api/activation-overview", (0, express_async_handler_1.default)(async (req, res) => {
    res.json({ success: true, ...(await (0, activationRunner_1.getActivationOverview)()) });
}));
// weekly activation report for checking the Monday invoice; ?week=2026-W41 (default: last week)
adminRoutes.get("/api/activation-report", (0, express_async_handler_1.default)(async (req, res) => {
    const week = String(req.query.week || (0, activationReport_1.defaultReportWeek)());
    const report = await (0, activationReport_1.getWeeklyReport)(week);
    if (!report) {
        res.status(400).json({ success: false, message: "week must look like 2026-W41" });
        return;
    }
    res.json({ success: true, ...report });
}));
// Pack check by any barcode of the pack: wrong cards, missing barcodes, and which missing
// barcode a wrong card most likely is. GET ?barcode=6338731070110036
adminRoutes.get("/api/pack-check", (0, express_async_handler_1.default)(async (req, res) => {
    const barcode = String(req.query.barcode || "").trim();
    if (!/^\d{16}$/.test(barcode)) {
        res.status(400).json({ success: false, message: "barcode must be 16 digits" });
        return;
    }
    res.json({ success: true, ...(await (0, packCheck_1.checkPackByBarcode)(barcode)) });
}));
// Pack check page: find a pack by any barcode, correct wrong scans, track corrections
adminRoutes.get("/pack-check", (0, express_async_handler_1.default)(async (req, res) => {
    const ean = await dbConnection_1.default.ean.findMany({ orderBy: { code: "asc" } });
    res.render("packCheck", {
        activePage: "pack-check",
        ean,
        allowedAmounts: activationRunner_1.ALLOWED_AMOUNTS,
        initialBarcode: String(req.query.barcode || ""),
    });
}));
adminRoutes.get("/api/barcode-corrections", (0, express_async_handler_1.default)(async (req, res) => {
    const rows = await (0, barcodeCorrection_1.listCorrections)({ q: String(req.query.q || ""), limit: Number(req.query.limit) || 100 });
    res.json({ success: true, corrections: rows });
}));
// { steamCardId, newBarcode, activate, eanId?, amount? }
adminRoutes.post("/api/barcode-corrections", (0, express_async_handler_1.default)(async (req, res) => {
    const { steamCardId, newBarcode } = req.body;
    if (!steamCardId || !newBarcode) {
        res.status(400).json({ success: false, message: "Missing steamCardId or newBarcode" });
        return;
    }
    try {
        const r = await (0, barcodeCorrection_1.correctBarcode)({
            steamCardId: String(steamCardId),
            newBarcode: String(newBarcode),
            activate: req.body.activate === true,
            eanId: optionalString(req.body.eanId),
            amount: optionalNumber(req.body.amount),
        });
        res.json({ success: true, ...r });
    }
    catch (err) {
        sendActivationError(res, err);
    }
}));
adminRoutes.post("/api/barcode-corrections/:id/activate", (0, express_async_handler_1.default)(async (req, res) => {
    try {
        const r = await (0, barcodeCorrection_1.activateCorrection)(req.params.id, { eanId: optionalString(req.body.eanId), amount: optionalNumber(req.body.amount) });
        res.json({ success: true, ...r });
    }
    catch (err) {
        sendActivationError(res, err);
    }
}));
adminRoutes.post("/api/activation-jobs/:id/pause", (0, express_async_handler_1.default)(async (req, res) => {
    try {
        await (0, activationRunner_1.pauseJob)(req.params.id);
        res.json({ success: true });
    }
    catch (err) {
        sendActivationError(res, err);
    }
}));
adminRoutes.post("/api/activation-jobs/:id/resume", (0, express_async_handler_1.default)(async (req, res) => {
    const finishAt = parseOptionalDate(req.body.finishAt);
    if (!finishAt) {
        res.status(400).json({ success: false, message: "Missing or invalid finishAt" });
        return;
    }
    try {
        await (0, activationRunner_1.resumeJob)(req.params.id, finishAt);
        res.json({ success: true });
    }
    catch (err) {
        sendActivationError(res, err);
    }
}));
adminRoutes.patch("/api/activation-jobs/:id", (0, express_async_handler_1.default)(async (req, res) => {
    const finishAt = parseOptionalDate(req.body.finishAt);
    if (finishAt === null) {
        res.status(400).json({ success: false, message: "Invalid finishAt" });
        return;
    }
    const amount = req.body.amount === undefined || req.body.amount === "" ? undefined : Number(req.body.amount);
    try {
        // fallback: absent = unchanged, {eanId:"", amount:""} = remove
        const fallback = req.body.fallback === undefined ? undefined
            : { eanId: optionalString(req.body.fallback?.eanId), amount: optionalNumber(req.body.fallback?.amount) };
        await (0, activationRunner_1.updateJobSettings)(req.params.id, { eanId: req.body.eanId || undefined, amount, finishAt, fallback });
        res.json({ success: true });
    }
    catch (err) {
        sendActivationError(res, err);
    }
}));
adminRoutes.post("/api/activation-jobs/:id/retry-failed", (0, express_async_handler_1.default)(async (req, res) => {
    try {
        await (0, activationRunner_1.retryFailed)(req.params.id, { eanId: optionalString(req.body.eanId), amount: optionalNumber(req.body.amount) });
        res.json({ success: true });
    }
    catch (err) {
        sendActivationError(res, err);
    }
}));
adminRoutes.post("/api/activation-items/:id/retry", (0, express_async_handler_1.default)(async (req, res) => {
    try {
        await (0, activationRunner_1.retryItem)(req.params.id, {
            barcode: req.body.barcode ? String(req.body.barcode) : undefined,
            eanId: optionalString(req.body.eanId),
            amount: optionalNumber(req.body.amount),
        });
        res.json({ success: true });
    }
    catch (err) {
        sendActivationError(res, err);
    }
}));
adminRoutes.get("/api/user/:user_id/tags", (0, express_async_handler_1.default)(async (req, res) => {
    const userId = req.params.user_id;
    const tagIds = await distinctTagIdsOfUser(userId);
    const tags = await dbConnection_1.default.tag.findMany({
        where: { id: { in: tagIds } },
        select: { id: true, name: true },
        // orderBy: { created_at: "desc" }, // only if exists
    });
    res.json({ success: true, tags });
}));
adminRoutes.get("/monthly-payout", (0, express_async_handler_1.default)(async (req, res) => {
    const users = await dbConnection_1.default.app_user.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" }
    });
    res.render("monthlyPayout", { users });
}));
adminRoutes.get("/api/monthly-payout", (0, express_async_handler_1.default)(async (req, res) => {
    const userId = String(req.query.userId || "");
    const month = String(req.query.month || ""); // "YYYY-MM"
    if (!userId || !month) {
        res.json({ success: false, message: "Missing userId or month" });
        return;
    }
    // =========================
    // helpers (same as you had)
    // =========================
    function parseTagDate(tagName) {
        if (!tagName)
            return null;
        const s = String(tagName);
        let m, parts, y, mo, da, dt, raw, yy;
        m = s.match(/(\d{4}[.\-/]\d{2}[.\-/]\d{2})/);
        if (m) {
            parts = m[1].replace(/[.\/]/g, "-").split("-");
            y = Number(parts[0]);
            mo = Number(parts[1]);
            da = Number(parts[2]);
            dt = new Date(y, mo - 1, da);
            if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === da)
                return dt;
        }
        m = s.match(/(\d{2}[.\-/]\d{2}[.\-/]\d{4})/);
        if (m) {
            parts = m[1].replace(/[.\/]/g, "-").split("-");
            da = Number(parts[0]);
            mo = Number(parts[1]);
            y = Number(parts[2]);
            dt = new Date(y, mo - 1, da);
            if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === da)
                return dt;
        }
        m = s.match(/(\d{2}[.\-/]\d{2}[.\-/]\d{2})/);
        if (m) {
            parts = m[1].replace(/[.\/]/g, "-").split("-");
            da = Number(parts[0]);
            mo = Number(parts[1]);
            yy = Number(parts[2]);
            y = 2000 + yy;
            dt = new Date(y, mo - 1, da);
            if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === da)
                return dt;
        }
        m = s.match(/(\d{8})/);
        if (m) {
            raw = m[1];
            y = Number(raw.slice(0, 4));
            mo = Number(raw.slice(4, 6));
            da = Number(raw.slice(6, 8));
            dt = new Date(y, mo - 1, da);
            if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === da)
                return dt;
        }
        return null;
    }
    function monthKey(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        return `${y}-${m}`;
    }
    // =========================
    // ALL users mode
    // =========================
    if (userId === "all") {
        const grouped = await dbConnection_1.default.steam_card.groupBy({
            by: ["user_id", "tag_id"],
            where: {
                //   user_id: { not: null },
                tag_id: { not: null },
            },
            _count: { _all: true },
        });
        const tagIds = Array.from(new Set(grouped.map(g => g.tag_id).filter((x) => typeof x === "string")));
        if (tagIds.length === 0) {
            res.json({ success: true, items: [], total: 0 });
            return;
        }
        const userIds = Array.from(new Set(grouped.map(g => g.user_id).filter((x) => typeof x === "string")));
        const [tags, users] = await Promise.all([
            dbConnection_1.default.tag.findMany({
                where: { id: { in: tagIds } },
                select: { id: true, name: true },
            }),
            dbConnection_1.default.app_user.findMany({
                where: { id: { in: userIds } },
                select: { id: true, name: true },
            }),
        ]);
        const tagMap = new Map(tags.map(t => [t.id, t]));
        const userMap = new Map(users.map(u => [u.id, u]));
        const items = [];
        for (const g of grouped) {
            if (typeof g.tag_id !== "string" || typeof g.user_id !== "string")
                continue;
            const tag = tagMap.get(g.tag_id);
            if (!tag)
                continue;
            const dt = parseTagDate(tag.name);
            if (!dt)
                continue;
            if (monthKey(dt) !== month)
                continue;
            const u = userMap.get(g.user_id);
            items.push({
                _rowId: `${g.user_id}:${g.tag_id}`,
                id: tag.id,
                name: tag.name,
                date: dt.toISOString(),
                count: g._count._all,
                user_id: g.user_id,
                user_name: u?.name || undefined,
            });
        }
        items.sort((a, b) => {
            const d = new Date(b.date).getTime() - new Date(a.date).getTime();
            if (d !== 0)
                return d;
            return String(a.user_name || a.user_id).localeCompare(String(b.user_name || b.user_id));
        });
        const total = items.reduce((sum, x) => sum + x.count, 0);
        res.json({ success: true, items, total });
        return;
    }
    // =========================
    // Single user mode (your old logic)
    // =========================
    const grouped = await dbConnection_1.default.steam_card.groupBy({
        by: ["tag_id"],
        where: { user_id: userId },
        _count: { _all: true },
    });
    const tagIds = grouped
        .map((g) => g.tag_id)
        .filter((x) => typeof x === "string");
    if (tagIds.length === 0) {
        res.json({ success: true, items: [], total: 0 });
        return;
    }
    const tags = await dbConnection_1.default.tag.findMany({
        where: { id: { in: tagIds } },
        select: { id: true, name: true },
    });
    const countMap = {};
    grouped.forEach((g) => {
        if (typeof g.tag_id === "string")
            countMap[g.tag_id] = g._count._all;
    });
    const items = [];
    for (const t of tags) {
        const dt = parseTagDate(t.name);
        if (!dt)
            continue;
        if (monthKey(dt) !== month)
            continue;
        items.push({
            _rowId: t.id, // unique enough in single-user mode
            id: t.id,
            name: t.name,
            date: dt.toISOString(),
            count: countMap[t.id] ?? 0,
        });
    }
    items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const total = items.reduce((sum, x) => sum + x.count, 0);
    res.json({ success: true, items, total });
}));
adminRoutes.post("/api/monthly-payout/count", (0, express_async_handler_1.default)(async (req, res) => {
    const userId = String(req.body.userId || "");
    const tagIds = Array.isArray(req.body.tagIds) ? req.body.tagIds : [];
    if (!userId) {
        res.json({ success: false, message: "Missing userId" });
        return;
    }
    const total = await dbConnection_1.default.steam_card.count({
        where: {
            user_id: userId,
            tag_id: { in: tagIds }
        }
    });
    res.json({ success: true, total });
}));
adminRoutes.get("/magic-links", (0, express_async_handler_1.default)(async (req, res) => {
    const magicLinks = await dbConnection_1.default.magic_link.findMany({
        orderBy: { created_at: "desc" }
    });
    res.render("magicLinks", { magicLinks });
}));
adminRoutes.post("/api/magic-links", (0, express_async_handler_1.default)(async (req, res) => {
    const start_at = new Date(req.body.start_at);
    const end_at = new Date(req.body.end_at);
    if (!start_at || !end_at || isNaN(start_at.getTime()) || isNaN(end_at.getTime())) {
        res.status(400).json({ success: false, message: "Invalid start/end" });
        return;
    }
    if (end_at <= start_at) {
        res.status(400).json({ success: false, message: "End must be after start" });
        return;
    }
    const created = await dbConnection_1.default.magic_link.create({
        data: {
            id: uuid_1.default.v4(),
            start_at, end_at
        }
    });
    res.json({ success: true, id: created.id });
}));
adminRoutes.get("/management", (0, express_async_handler_1.default)(async (req, res) => {
    const users = await dbConnection_1.default.app_user.findMany();
    res.render("management", { users });
}));
adminRoutes.post("/get-tags-by-user", (0, express_async_handler_1.default)(async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        res.json({ error: "No userId", result: null });
    }
    const tags = await dbConnection_1.default.tag.findMany({
        where: {
            userId: userId
        }
    });
    res.json(tags);
}));
adminRoutes.post("/update-tag-toggle", (0, express_async_handler_1.default)(async (req, res) => {
    const { tagId, field, value } = req.body;
    if (!tagId) {
        res.status(400).json({ ok: false, error: "tagId required" });
        return;
    }
    // Allow ONLY these fields to be updated (security)
    const allowed = new Set(["is_activated", "is_visible_to_user"]);
    if (!allowed.has(field)) {
        res.status(400).json({ ok: false, error: "Invalid field" });
        return;
    }
    const boolValue = Boolean(value);
    const updated = await dbConnection_1.default.tag.update({
        where: { id: tagId },
        data: { [field]: boolValue },
        select: {
            id: true,
            is_activated: true,
            is_visible_to_user: true,
        },
    });
    res.json({ ok: true, tag: updated });
}));
exports.default = adminRoutes;
