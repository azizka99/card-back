import express from "express";
import { getApiVersion } from "../../controllers/client/versionController";
import { createScan, getScannedCardsByTagId } from "../../controllers/client/scanController";
import multer from "multer";
import { createTag, getTagsByUserId } from "../../controllers/client/tagController";
import { checkScannedCards } from "../../controllers/client/errorCardsController";




const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

router.get("/v", getApiVersion);

router.post("/createTag", createTag);

router.post("/get-tags-by-userid", getTagsByUserId);

router.post("/scannedSteam", upload.single("img"), createScan);

router.post('/check-scanned-cards', checkScannedCards);
router.post('/get-cards-by-tagId', getScannedCardsByTagId);











export default router;