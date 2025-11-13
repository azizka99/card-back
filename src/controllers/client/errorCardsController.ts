import expressAsyncHandler from "express-async-handler";
import { SteamCard } from "../../models/SteamCard";

export const checkScannedCards = expressAsyncHandler(async (req, res) => {
    const { tag_id } = req.body;

    if (!tag_id) {
        res.status(400).json({ error: "There is no tag_id" });
        return;
    }

    // 🔥 Fire-and-forget background job (no await!)
    setImmediate(async () => {
        try {
            console.log(`[checkScannedCards] Starting background check for tag`, tag_id);
            await SteamCard.checkErrorsByTagId(tag_id);
            console.log(`[checkScannedCards] Finished background check for tag`, tag_id);
        } catch (err) {
            console.error(`[checkScannedCards] Background check failed for tag ${tag_id}:`, err);
            // optional: write to a log table, send email, etc.
        }
    });

    // 👇 Immediate response to Flutter
    res.json({
        error: null,
        result: `${tag_id} - check started in background`,
    });
});