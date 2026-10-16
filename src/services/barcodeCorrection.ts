import prisma from "../constants/dbConnection";
import { isValidBarcode } from "../helpers/generateLuhn";
import { ActivationError, activateCard } from "./activationRunner";

/**
 * Change a wrongly scanned barcode to the real one, keep the old -> new history,
 * and optionally send the card to activation right away.
 */
export async function correctBarcode(opts: {
    steamCardId: string;
    newBarcode: string;
    activate: boolean;
    eanId?: string | null;
    amount?: number | null;
}) {
    const newBarcode = opts.newBarcode.trim();
    if (!isValidBarcode(newBarcode)) {
        throw new ActivationError(400, "Not a valid barcode: 16 digits with a correct check digit (last digit). Check for a typo.");
    }
    const card = await prisma.steam_card.findUnique({ where: { id: opts.steamCardId } });
    if (!card) throw new ActivationError(404, "Card not found");
    if (card.barcode === newBarcode) throw new ActivationError(400, "The card already has this barcode");

    const taken = await prisma.steam_card.findUnique({ where: { barcode: newBarcode }, select: { tag: { select: { name: true } } } });
    if (taken) throw new ActivationError(409, `This barcode already belongs to another card (tag ${taken.tag?.name ?? "—"})`);

    const oldBarcode = card.barcode;
    const correctionId = crypto.randomUUID();
    try {
        // barcode change and its history row: both or neither
        await prisma.$transaction([
            prisma.steam_card.update({ where: { id: card.id }, data: { barcode: newBarcode } }),
            // queued / failed activations of this card must use the new barcode too
            prisma.activation_item.updateMany({
                where: { steam_card_id: card.id, status: { in: ["pending", "failed"] } },
                data: { barcode: newBarcode },
            }),
            prisma.barcode_correction.create({
                data: {
                    id: correctionId, steam_card_id: card.id, old_barcode: oldBarcode, new_barcode: newBarcode,
                    pack_id: card.pack_id, source: "pack_check",
                },
            }),
        ]);
    } catch (err: any) {
        if (err?.code === "P2002") throw new ActivationError(409, "This barcode already belongs to another card");
        throw err;
    }

    if (!opts.activate) return { correctionId, oldBarcode, newBarcode, activationItemId: null, activationError: null };

    // barcode is changed and recorded either way; activation problems are reported, not thrown
    try {
        const activationItemId = await activateCard(card.id, { eanId: opts.eanId, amount: opts.amount });
        await prisma.barcode_correction.update({ where: { id: correctionId }, data: { activation_item_id: activationItemId } });
        return { correctionId, oldBarcode, newBarcode, activationItemId, activationError: null };
    } catch (err: any) {
        if (!(err instanceof ActivationError)) throw err;
        return { correctionId, oldBarcode, newBarcode, activationItemId: null, activationError: err.message };
    }
}

/** Send an already corrected card to activation (from the history list). */
export async function activateCorrection(correctionId: string, opts: { eanId?: string | null; amount?: number | null }) {
    const c = await prisma.barcode_correction.findUnique({ where: { id: correctionId } });
    if (!c) throw new ActivationError(404, "Correction not found");
    const activationItemId = await activateCard(c.steam_card_id, opts);
    await prisma.barcode_correction.update({ where: { id: correctionId }, data: { activation_item_id: activationItemId } });
    return { activationItemId };
}

type CorrectionRow = {
    id: string; created_at: Date; old_barcode: string; new_barcode: string; source: string;
    steam_card_id: string; pack_id: string | null; tag_id: string | null; tag_name: string | null; current_barcode: string | null;
    act_status: string | null; act_result: string | null; act_ean: string | null; act_amount: number | null;
    act_at: Date | null; act_job_status: string | null;
};

/**
 * Corrections, newest first, with the activation result: the linked activation if one was sent,
 * else the card's latest activation after the correction (e.g. the tag's normal run).
 */
export async function listCorrections(opts: { q?: string; packId?: string; limit?: number } = {}) {
    const q = (opts.q || "").trim();
    const like = `%${q}%`;
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = await prisma.$queryRaw<CorrectionRow[]>`
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
