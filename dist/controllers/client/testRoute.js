"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const testRoutes = express_1.default.Router();
testRoutes.get("/bank", (0, express_async_handler_1.default)(async (req, res) => {
    res.render("sanitazeBank");
}));
function detectBankCsvFormat(rawCsvText) {
    // Normalize BOM + line endings
    const text = rawCsvText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Check only first N lines to be fast and robust
    const lines = text.split("\n").slice(0, 40).map(l => l.trim()).filter(Boolean);
    const headerA = "Buchungstag;Wert;Umsatzart;Begünstigter / Auftraggeber;Verwendungszweck";
    const headerB = "Bezeichnung Auftragskonto;IBAN Auftragskonto;BIC Auftragskonto;Bankname Auftragskonto;Buchungstag";
    // Find header line index for A
    const idxA = lines.findIndex(l => l.startsWith("Buchungstag;") && l.includes("Umsatzart;") && l.includes("Verwendungszweck;"));
    if (idxA !== -1)
        return { format: "POSTBANK_UMSAETZE", headerIndex: idxA };
    // B header usually is first line, but we detect anywhere in first lines
    const idxB = lines.findIndex(l => l.startsWith("Bezeichnung Auftragskonto;") && l.includes("Verwendungszweck;") && l.includes("Betrag;"));
    if (idxB !== -1)
        return { format: "STANDARD_EXPORT", headerIndex: idxB };
    // Fallback heuristics (optional): if file begins with "Umsätze" and later contains Buchungstag;Wert...
    if (lines[0]?.toLowerCase().includes("umsätze") && lines.some(l => l.startsWith("Buchungstag;Wert;"))) {
        return { format: "POSTBANK_UMSAETZE", headerIndex: lines.findIndex(l => l.startsWith("Buchungstag;Wert;")) };
    }
    return { format: "UNKNOWN", headerIndex: -1 };
}
function stripToHeader(rawCsvText, headerIndexInPreview, headerStartsWith) {
    const text = rawCsvText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const allLines = text.split("\n");
    // If we detected header index in the preview lines, we still need the real index in full file:
    // safer: find header line by "startsWith" + includes checks in the full file.
    const realIdx = allLines.findIndex(l => {
        const t = (l || "").trim();
        return t.startsWith(headerStartsWith);
    });
    if (realIdx === -1)
        return null; // header not found
    return allLines.slice(realIdx).join("\n");
}
testRoutes.post("/bank-analzye", upload.single("file"), (0, express_async_handler_1.default)(async (req, res) => {
    try {
        if (!req.file) {
            res.status(400).json({ error: "No file was uploaded." });
            return;
        }
        const rawCsvText = req.file.buffer.toString("utf-8");
        const detected = detectBankCsvFormat(rawCsvText);
        if (detected.format === "UNKNOWN") {
            res.status(400).json({
                error: "Unsupported bank CSV format",
                hint: "Expected either Postbank Umsätze export or standard export with 'Bezeichnung Auftragskonto...'",
            });
            return;
        }
        let csvForParsing = rawCsvText;
        if (detected.format === "POSTBANK_UMSAETZE") {
            const stripped = stripToHeader(rawCsvText, detected.headerIndex, "Buchungstag;Wert;Umsatzart;");
            if (!stripped) {
                res.status(400).json({ error: "Could not find header row in Postbank Umsätze CSV" });
                return;
            }
            csvForParsing = stripped;
        }
        else if (detected.format === "STANDARD_EXPORT") {
            // parse from start (or from detected header if you want to be extra safe)
            const stripped = stripToHeader(rawCsvText, detected.headerIndex, "Bezeichnung Auftragskonto;");
            csvForParsing = stripped ?? rawCsvText;
        }
        // Replace these dummy values with your actual processed data
        res.status(200).json({
            csvText: `${detected.format} \n ${csvForParsing.split("\n")[0]?.slice(0, 200)}`, // The text for the small preview window
            downloadUrl: "/downloads/your-new-sanitized-file.csv" // URL where the user can download the final file
        });
    }
    catch (error) {
        console.error("Error processing file:", error);
        res.status(500).json({ error: "An error occurred while processing the file." });
    }
}));
exports.default = testRoutes;
