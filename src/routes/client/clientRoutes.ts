import express from "express";
import { getApiVersion } from "../../controllers/client/versionController";
import { createScan } from "../../controllers/client/scanController";
import multer from "multer";



const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

router.get("/v", getApiVersion);

router.post("/scannedSteam", upload.single("img"),createScan);








export default router;