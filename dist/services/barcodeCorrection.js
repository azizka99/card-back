"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.correctBarcode = correctBarcode;
exports.activateCorrection = activateCorrection;
exports.listCorrections = listCorrections;
const dbConnection_1 = __importDefault(require("../constants/dbConnection"));
const generateLuhn_1 = require("../helpers/generateLuhn");
const activationRunner_1 = require("./activationRunner");
/**
 * Change a wrongly scanned barcode to the real one, keep the old -> new history,
 * and optionally send the card to activation right away.
 */
async function correctBarcode(opts) {
    const newBarcode = opts.newBarcode.trim();
    if (!(0, generateLuhn_1.isValidBarcode)(newBarcode)) {
        throw new activationRunner_1.ActivationError(400, "Not a valid barcode: 16 digits with a correct check digit (last digit). Check for a typo.");
    }
    const card = await dbConnection_1.default.steam_card.findUnique({ where: { id: opts.steamCardId } });
    if (!card)
        throw new activationRunner_1.ActivationError(404, "Card not found");
    if (card.barcode === newBarcode)
        throw new activationRunner_1.ActivationError(400, "The card already has this barcode");
    const taken = await dbConnection_1.default.steam_card.findUnique({ where: { barcode: newBarcode }, select: { tag: { select: { name: true } } } });
    if (taken)
        throw new activationRunner_1.ActivationError(409, `This barcode already belongs to another card (tag ${taken.tag?.name ?? "—"})`);
    const oldBarcode = card.barcode;
    const correctionId = crypto.randomUUID();
    try {
        // barcode change and its history row: both or neither
        await dbConnection_1.default.$transaction([
            dbConnection_1.default.steam_card.update({ where: { id: card.id }, data: { barcode: newBarcode } }),
            // queued / failed activations of this card must use the new barcode too
            dbConnection_1.default.activation_item.updateMany({
                where: { steam_card_id: card.id, status: { in: ["pending", "failed"] } },
                data: { barcode: newBarcode },
            }),
            dbConnection_1.default.barcode_correction.create({
                data: {
                    id: correctionId, steam_card_id: card.id, old_barcode: oldBarcode, new_barcode: newBarcode,
                    pack_id: card.pack_id, source: "pack_check",
                },
            }),
        ]);
    }
    catch (err) {
        if (err?.code === "P2002")
            throw new activationRunner_1.ActivationError(409, "This barcode already belongs to another card");
        throw err;
    }
    if (!opts.activate)
        return { correctionId, oldBarcode, newBarcode, activationItemId: null, activationError: null };
    // barcode is changed and recorded either way; activation problems are reported, not thrown
    try {
        const activationItemId = await (0, activationRunner_1.activateCard)(card.id, { eanId: opts.eanId, amount: opts.amount });
        await dbConnection_1.default.barcode_correction.update({ where: { id: correctionId }, data: { activation_item_id: activationItemId } });
        return { correctionId, oldBarcode, newBarcode, activationItemId, activationError: null };
    }
    catch (err) {
        if (!(err instanceof activationRunner_1.ActivationError))
            throw err;
        return { correctionId, oldBarcode, newBarcode, activationItemId: null, activationError: err.message };
    }
}
/** Send an already corrected card to activation (from the history list). */
async function activateCorrection(correctionId, opts) {
    const c = await dbConnection_1.default.barcode_correction.findUnique({ where: { id: correctionId } });
    if (!c)
        throw new activationRunner_1.ActivationError(404, "Correction not found");
    const activationItemId = await (0, activationRunner_1.activateCard)(c.steam_card_id, opts);
    await dbConnection_1.default.barcode_correction.update({ where: { id: correctionId }, data: { activation_item_id: activationItemId } });
    return { activationItemId };
}
/**
 * Corrections, newest first, with the activation result: the linked activation if one was sent,
 * else the card's latest activation after the correction (e.g. the tag's normal run).
 */
async function listCorrections(opts = {}) {
    const q = (opts.q || "").trim();
    const like = `%${q}%`;
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = await dbConnection_1.default.$queryRaw `
        SELECT bc.id, bc.created_at, bc.old_barcode, bc.new_barcode, bc.source, bc.steam_card_id, bc.pack_id,
               c.tag_id, t.name AS tag_name, c.barcode AS current_barcode,
               i.status AS act_status, i.result_text AS act_result, i.ean AS act_ean, i.amount AS act_amount,
               i.updated_at AS act_at, j.status AS act_job_status
        FROM barcode_correction bc
        LEFT JOIN steam_card c ON c.id = bc.steam_card_id
        LEFT JOIN tag t ON t.id = c.tag_id
        LEFT JOIN LATERAL (
            SELECT * FROM activation_item ai
            WHERE ai.id = bc.activation_item_id
               OR (bc.activation_item_id IS NULL AND ai.steam_card_id = bc.steam_card_id AND ai.updated_at >= bc.created_at)
            ORDER BY (ai.id = bc.activation_item_id) DESC NULLS LAST, ai.updated_at DESC
            LIMIT 1
        ) i ON TRUE
        LEFT JOIN activation_job j ON j.id = i.job_id
        WHERE (${q} = '' OR bc.old_barcode LIKE ${like} OR bc.new_barcode LIKE ${like} OR t.name ILIKE ${like})
          AND (${opts.packId ?? null}::uuid IS NULL OR bc.pack_id = ${opts.packId ?? null}::uuid)
        ORDER BY bc.created_at DESC
        LIMIT ${limit}`;
    return rows;
}
