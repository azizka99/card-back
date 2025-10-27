import express from "express";
import { getApiVersion } from "../../controllers/client/versionController";
import { createScan } from "../../controllers/client/scanController";
import multer from "multer";
import { ocrTesseract } from "../../controllers/client/ocrController";



const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

router.get("/v", getApiVersion);

router.post("/scannedSteam", upload.single("img"),createScan);

router.post("/ocr/tesseract", upload.single("img"), ocrTesseract);






export default router;