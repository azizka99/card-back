import express from "express";
import { getApiVersion } from "../../controllers/client/versionController";
import { createScan } from "../../controllers/client/scanController";
import multer from "multer";
import { createTag, getTagsByUserId } from "../../controllers/client/tagController";




const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

router.get("/v", getApiVersion);

router.post("/createTag", createTag);

router.post("/get-tags-by-userid", getTagsByUserId);

router.post("/scannedSteam", upload.single("img"), createScan);











export default router;