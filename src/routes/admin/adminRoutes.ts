import express from "express";
import expressAsyncHandler from "express-async-handler";


const adminRoutes = express.Router();


adminRoutes.get("/dashboard", expressAsyncHandler(async (req, res) => {
    res.render("adminDashboard.ejs");
}));







export default adminRoutes;