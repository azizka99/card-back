import expressAsyncHandler from "express-async-handler";
import { Tag } from "../../models/Tag";

export const createTag = expressAsyncHandler(async (req, res) => {
    const { id, name, created_at, userId } = req.body;

    // Validate input
    if (!id || !name) {
        res.status(400);
        throw new Error("Missing id or name");
    }

    // If created_at is not valid, fall back to now
    const safeCreatedAt = !isNaN(new Date(created_at).getTime())
        ? new Date(created_at)
        : new Date();

    const tag = new Tag(id, name, safeCreatedAt, userId);

    // 👇 await this line
    const result = await Tag.createTag(tag);

    res.json({
        error: null,
        result: "created",
    });
});



export const getTagsByUserId = expressAsyncHandler(async (req, res) => {
    const { userid } = req.body;

    if (!userid) {
        res.status(400);
        throw new Error("Missing id");
    }

    const tags = await Tag.findTagByUserId(userid);

    res.json({
        errur: null,
        result: tags
    })

});


