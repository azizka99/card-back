import express from "express";
import expressAsyncHandler from "express-async-handler";
import prisma from "../../constants/dbConnection";


const adminRoutes = express.Router();


adminRoutes.get("/dashboard", expressAsyncHandler(async (req, res) => {
    res.render("adminDashboard.ejs");
}));


adminRoutes.get("/live-feed", expressAsyncHandler(async (req, res) => {
    const steam_cards = await prisma.steam_card.findMany({
        include: {
            app_user: true,
            tag: true
        },
        take: 100,
        orderBy: { created_at: "desc" }
    });

    res.render("live-feed", {
        items:steam_cards,
        latestTs: steam_cards[0]?.created_at?.toISOString?.() || null,
    });
}));





export default adminRoutes;