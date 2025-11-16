"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/client/specialClientRoutes.ts
const express_1 = __importDefault(require("express"));
const dbConnection_1 = __importDefault(require("../../constants/dbConnection"));
const special_client = express_1.default.Router();
// ---- Middleware to protect special-client pages ----
function requireSpecialClientAuth(req, res, next) {
    if (req.session?.specialClientAuthed)
        return next();
    return res.redirect("/special-client/login");
}
// ---- GET /special-client/login ----
special_client.get("/login", async (req, res) => {
    res.render("special-client/login", { error: null });
});
// ---- POST /special-client/login ----
special_client.post("/login", async (req, res) => {
    const { email, password } = req.body;
    if (email === "e.kilinc36@gmail.com" && password === "erdincABI$$669966$$") {
        req.session.specialClientAuthed = true;
        req.session.specialClientUserId = "d923c912-602d-4b93-9041-7b9a5c246b22";
        return res.redirect("/special-client/upload");
    }
    else if (email === "ik@arascom.de" && password === "ikABIIBO$$6669888222$$") {
        req.session.specialClientAuthed = true;
        req.session.specialClientUserId = "b2e6e19d-64b8-4b6a-a6e7-92f18cfcecf2";
        return res.redirect("/special-client/upload");
    }
    return res
        .status(401)
        .render("special-client/login", { error: "Invalid credentials" });
});
// ---- POST /special-client/logout ----
special_client.post("/logout", async (req, res) => {
    req.session.specialClientAuthed = false;
    return res.redirect("/special-client/login");
});
// ---- PROTECTED PAGE (later will be big upload page) ----
special_client.get("/upload", requireSpecialClientAuth, async (req, res) => {
    const userId = req.session.specialClientUserId;
    const tags = await dbConnection_1.default.tag.findMany({
        where: {
            userId
        }
    });
    res.render("special-client/upload", { tags, userId });
});
exports.default = special_client;
