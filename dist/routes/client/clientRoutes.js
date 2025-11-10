"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const versionController_1 = require("../../controllers/client/versionController");
const scanController_1 = require("../../controllers/client/scanController");
const multer_1 = __importDefault(require("multer"));
const tagController_1 = require("../../controllers/client/tagController");
const errorCardsController_1 = require("../../controllers/client/errorCardsController");
const router = express_1.default.Router();
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
router.get("/v", versionController_1.getApiVersion);
router.post("/createTag", tagController_1.createTag);
router.post("/get-tags-by-userid", tagController_1.getTagsByUserId);
router.post("/scannedSteam", upload.single("img"), scanController_1.createScan);
router.post('/check-scanned-cards', errorCardsController_1.checkScannedCards);
exports.default = router;
