import expressAsyncHandler from "express-async-handler";
import { User } from "../../models/User";





export const login = expressAsyncHandler(async (req, res) => {
    const { email, password } = req.body;


    if (!email || !password) {
        res.status(400);
        throw new Error("Missing email or password");
    }

    const user = await User.findUserByEmail(email);

    if (!user) {
        res.json({ result: null, error: "There is email or password is wrong" });
        return;
    }
    if (!user.getUser().password === password) {
        res.json({ result: null, error: "There is email or password is wrong" });
        return;
    }

    const token = User.signInUser(user.getUser().id);

    res.json({
        error: null,
        result: { token, userid: user.getUser().id }
    })
});