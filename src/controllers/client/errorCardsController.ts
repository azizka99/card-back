import expressAsyncHandler from "express-async-handler";
import { SteamCard } from "../../models/SteamCard";

export const checkScannedCards = expressAsyncHandler(async (req, res) => {
    const { tag_id } = req.body;
    if (!tag_id) {
        res.json({ error: "There is no tag_id" });
        return;
    }
    await SteamCard.checkErrorsByTagId(tag_id);

    res.json({ error: null, result: `${tag_id} - is Checked` })
});