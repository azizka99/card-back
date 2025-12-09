import expressAsyncHandler from "express-async-handler";
import { Pack } from "../../models/Pack";






export const createPack = expressAsyncHandler(async (req, res) => {
    const { id, number } = req.body;

    if (!id || !number) {
        res.json({ error: "no id or number" });
        return;
    }
    const pack = await Pack.createPack(new Pack(number, id));

    res.json({ result: { id: pack?.id } });
});


export const checkPack = expressAsyncHandler(async (req, res) => {
    const { id } = req.body;

    if (!id) {
        res.json({ error: "no id or number" });
        return;
    }
    const pack = await Pack.findPackById(id);
    if (!pack) {
        res.json({ error: `Couldn't find a pack by this ${id} Id ` })
    }
    const checked = await Pack.checkPack(new Pack(pack?.start_number as string, pack?.id as string));

    res.json({
        result: { checked }
    })
});