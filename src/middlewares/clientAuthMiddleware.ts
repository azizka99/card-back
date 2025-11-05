import expressAsyncHandler from "express-async-handler";
import { verifyToken } from "../helpers/jwt";

export const clientAuthMiddleWare = expressAsyncHandler(async (req, res, next) => {


    const headerToken = req.headers.authorization;

    if (!headerToken) {
        res.json({ result: null, error: "No token" }); return;
    }
    const token = headerToken?.split(" ")[1];
    if (!token) { res.status(401).json({ error: "No token" }); return; }
    const payload = verifyToken(token as string);

    req.body.userid = payload.userId;

    next()

});