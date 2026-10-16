import prisma from "../constants/dbConnection";
import { generateFixed200 } from "../helpers/generateLuhn";

// A pack holds 200 cards with consecutive barcodes from pack.start_number (Luhn check digit at the end).
// A misread barcode shows up as an "extra" card in the pack while the real card's barcode is "missing";
// the missing barcode with the fewest differing digits is the most likely real one.

function digitDiff(a: string, b: string) {
    if (a.length !== b.length) return Math.max(a.length, b.length);
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
}

/** Pack whose 200-barcode range contains this barcode (compares the 15-digit payload). */
async function findPackByRange(barcode: string) {
    const rows = await prisma.$queryRaw<{ id: string; start_number: string }[]>`
        SELECT id, start_number FROM pack
        WHERE start_number ~ '^[0-9]{16}$'
          AND left(${barcode}, 15)::bigint - left(start_number, 15)::bigint BETWEEN 0 AND 199
        LIMIT 1`;
    return rows[0] ?? null;
}

export async function checkPackByBarcode(barcode: string) {
    const card = await prisma.steam_card.findUnique({
        where: { barcode },
        select: { id: true, barcode: true, pack_id: true, tag: { select: { name: true } } },
    });

    // the card's own pack; else (barcode not in DB / no pack) the pack whose range contains it
    let pack = card?.pack_id ? await prisma.pack.findUnique({ where: { id: card.pack_id } }) : null;
    let foundBy: "card" | "range" = "card";
    if (!pack) {
        pack = await findPackByRange(barcode);
        foundBy = "range";
    }
    if (!pack) {
        return { barcode, inDatabase: !!card, pack: null, message: "No pack found for this barcode (card has no pack and no pack's range contains it)." };
    }

    const expected = generateFixed200(pack.start_number);
    const expectedSet = new Set(expected);
    const cards = await prisma.steam_card.findMany({
        where: { pack_id: pack.id },
        select: { id: true, barcode: true, created_at: true, tag: { select: { name: true } }, app_user: { select: { name: true } } },
        orderBy: { created_at: "asc" },
    });

    const scanned = new Set(cards.map((c) => c.barcode)); // barcode is unique, so no duplicates
    const missing = expected.filter((b) => !scanned.has(b));
    const extra = cards.filter((c) => !expectedSet.has(c.barcode));

    // pair each wrong card with the closest missing barcode (each missing one used once)
    const free = new Set(missing);
    const wrongCards = extra
        .map((c) => {
            let best: string | null = null;
            let bestDiff = Infinity;
            for (const m of free) {
                const d = digitDiff(c.barcode, m);
                if (d < bestDiff) { bestDiff = d; best = m; }
            }
            if (best && bestDiff <= 6) free.delete(best);
            return {
                barcode: c.barcode,
                tag: c.tag?.name ?? null,
                scannedBy: c.app_user?.name ?? null,
                scannedAt: c.created_at,
                likelyRealBarcode: best && bestDiff <= 6 ? best : null,
                digitsDifferent: best && bestDiff <= 6 ? bestDiff : null,
            };
        });

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
        wrongCards,
        missing,
    };
}
