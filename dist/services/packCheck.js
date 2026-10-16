"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkPackByBarcode = checkPackByBarcode;
const dbConnection_1 = __importDefault(require("../constants/dbConnection"));
const generateLuhn_1 = require("../helpers/generateLuhn");
const barcodeCorrection_1 = require("./barcodeCorrection");
// A pack holds 200 cards with consecutive barcodes from pack.start_number (Luhn check digit at the end).
// A misread barcode shows up as an "extra" card in the pack while the real card's barcode is "missing";
// the missing barcode with the fewest differing digits is the most likely real one.
function digitDiff(a, b) {
    if (a.length !== b.length)
        return Math.max(a.length, b.length);
    let n = 0;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            n++;
    return n;
}
/** Pack whose 200-barcode range contains this barcode (compares the 15-digit payload). */
async function findPackByRange(barcode) {
    const rows = await dbConnection_1.default.$queryRaw `
        SELECT id, start_number FROM pack
        WHERE start_number ~ '^[0-9]{16}$'
          AND left(${barcode}, 15)::bigint - left(start_number, 15)::bigint BETWEEN 0 AND 199
        LIMIT 1`;
    return rows[0] ?? null;
}
async function checkPackByBarcode(barcode) {
    const card = await dbConnection_1.default.steam_card.findUnique({
        where: { barcode },
        select: { id: true, barcode: true, pack_id: true, tag: { select: { name: true } } },
    });
    // the card's own pack; else (barcode not in DB / no pack) the pack whose range contains it
    let pack = card?.pack_id ? await dbConnection_1.default.pack.findUnique({ where: { id: card.pack_id } }) : null;
    let foundBy = "card";
    if (!pack) {
        pack = await findPackByRange(barcode);
        foundBy = "range";
    }
    if (!pack) {
        return { barcode, inDatabase: !!card, pack: null, message: "No pack found for this barcode (card has no pack and no pack's range contains it)." };
    }
    const expected = (0, generateLuhn_1.generateFixed200)(pack.start_number);
    const expectedSet = new Set(expected);
    const cards = await dbConnection_1.default.steam_card.findMany({
        where: { pack_id: pack.id },
        select: { id: true, barcode: true, created_at: true, tag_id: true, tag: { select: { name: true } }, app_user: { select: { name: true } } },
        orderBy: { created_at: "asc" },
    });
    const scanned = new Set(cards.map((c) => c.barcode)); // barcode is unique, so no duplicates
    const missing = expected.filter((b) => !scanned.has(b));
    const extra = cards.filter((c) => !expectedSet.has(c.barcode));
    // pair each wrong card with the closest missing barcode (each missing one used once)
    const free = new Set(missing);
    const wrongCards = extra
        .map((c) => {
        let best = null;
        let bestDiff = Infinity;
        for (const m of free) {
            const d = digitDiff(c.barcode, m);
            if (d < bestDiff) {
                bestDiff = d;
                best = m;
            }
        }
        if (best && bestDiff <= 6)
            free.delete(best);
        return {
            steamCardId: c.id,
            tagId: c.tag_id,
            barcode: c.barcode,
            tag: c.tag?.name ?? null,
            scannedBy: c.app_user?.name ?? null,
            scannedAt: c.created_at,
            likelyRealBarcode: best && bestDiff <= 6 ? best : null,
            digitsDifferent: best && bestDiff <= 6 ? bestDiff : null,
        };
    });
    // latest activation of each wrong card (an activated wrong barcode may have activated someone else's card)
    const acts = extra.length
        ? await dbConnection_1.default.activation_item.findMany({
            where: { steam_card_id: { in: extra.map((c) => c.id) } },
            orderBy: { updated_at: "desc" },
            select: { steam_card_id: true, status: true, result_text: true, barcode: true, ean: true, amount: true, updated_at: true, job: { select: { status: true } } },
        })
        : [];
    const lastAct = new Map();
    for (const a of acts)
        if (!lastAct.has(a.steam_card_id))
            lastAct.set(a.steam_card_id, a);
    // default EAN / amount for activating a corrected card: the tag's latest run
    const tagIds = Array.from(new Set(extra.map((c) => c.tag_id).filter((t) => !!t)));
    const lastJobs = tagIds.length
        ? await dbConnection_1.default.activation_job.findMany({ where: { tag_id: { in: tagIds } }, orderBy: { created_at: "desc" }, select: { tag_id: true, ean: true, amount: true } })
        : [];
    const defaults = new Map();
    for (const j of lastJobs)
        if (!defaults.has(j.tag_id))
            defaults.set(j.tag_id, { ean: j.ean, amount: j.amount });
    const queriedIsWrong = !!card && !expectedSet.has(barcode);
    const match = wrongCards.find((w) => w.barcode === barcode);
    return {
        barcode,
        inDatabase: !!card,
        status: !card ? "not_in_database" : queriedIsWrong ? "wrong_for_this_pack" : "ok",
        // the answer to "instead of this card, which one is missing?"
        likelyRealBarcode: match?.likelyRealBarcode ?? null,
        pack: {
            id: pack.id,
            start: expected[0],
            end: expected[expected.length - 1],
            foundBy,
        },
        counts: {
            expected: expected.length,
            scanned: cards.length,
            correct: cards.length - extra.length,
            wrong: extra.length,
            missing: missing.length,
        },
        wrongCards: wrongCards.map((w) => {
            const a = lastAct.get(w.steamCardId);
            return {
                ...w,
                activation: a ? {
                    status: a.status, result: a.result_text, barcode: a.barcode, ean: a.ean, amount: a.amount,
                    at: a.updated_at, jobStatus: a.job.status,
                } : null,
                tagActivatedBefore: !!(w.tagId && defaults.has(w.tagId)),
                defaultEan: w.tagId ? defaults.get(w.tagId)?.ean ?? null : null,
                defaultAmount: w.tagId ? defaults.get(w.tagId)?.amount ?? null : null,
            };
        }),
        missing,
        corrections: await (0, barcodeCorrection_1.listCorrections)({ packId: pack.id, limit: 200 }),
    };
}
