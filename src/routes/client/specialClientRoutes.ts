// src/routes/client/specialClientRoutes.ts
import express from "express";

const special_client = express.Router();

const SPECIAL_CLIENT_EMAIL =
    process.env.SPECIAL_CLIENT_EMAIL || "client@example.com";
const SPECIAL_CLIENT_PASS =
    process.env.SPECIAL_CLIENT_PASS || "client-secret";

// ---- Middleware to protect special-client pages ----
function requireSpecialClientAuth(req: any, res: any, next: any) {
    if (req.session?.specialClientAuthed) return next();
    return res.redirect("/special-client/login");
}

// ---- GET /special-client/login ----
special_client.get("/login", (req, res) => {
    res.render("special-client/login", { error: null });
});

// ---- POST /special-client/login ----
special_client.post("/login", (req: any, res: any) => {
    const { email, password } = req.body;

    if (email === SPECIAL_CLIENT_EMAIL && password === SPECIAL_CLIENT_PASS) {
        req.session.specialClientAuthed = true;
        return res.redirect("/special-client/upload");
    }

    return res
        .status(401)
        .render("special-client/login", { error: "Invalid credentials" });
});

// ---- POST /special-client/logout ----
special_client.post("/logout", (req: any, res: any) => {
    req.session.specialClientAuthed = false;
    return res.redirect("/special-client/login");
});

// ---- PROTECTED PAGE (later will be big upload page) ----
special_client.get("/upload", requireSpecialClientAuth, (req, res) => {
    res.render("special-client/upload");
});

export default special_client;