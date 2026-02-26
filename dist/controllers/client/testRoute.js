"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const sync_1 = require("csv-parse/sync");
const testRoutes = express_1.default.Router();
testRoutes.get("/bank", (0, express_async_handler_1.default)(async (req, res) => {
    res.render("sanitazeBank");
}));
function detectBankCsvFormat(rawCsvText) {
    const text = rawCsvText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = text.split("\n").slice(0, 40).map(l => l.trim()).filter(Boolean);
    const idxA = lines.findIndex(l => l.startsWith("Buchungstag;") &&
        l.includes("Umsatzart;") &&
        l.includes("Verwendungszweck;"));
    if (idxA !== -1)
        return { format: "POSTBANK_UMSAETZE" };
    const idxB = lines.findIndex(l => l.startsWith("Bezeichnung Auftragskonto;") &&
        l.includes("Verwendungszweck;") &&
        l.includes("Betrag;"));
    if (idxB !== -1)
        return { format: "STANDARD_EXPORT" };
    return { format: "UNKNOWN" };
}
function stripToHeader(rawCsvText, headerStartsWith) {
    const text = rawCsvText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = text.split("\n");
    const headerIndex = lines.findIndex(l => (l || "").trim().startsWith(headerStartsWith));
    if (headerIndex === -1)
        return null;
    return lines.slice(headerIndex).join("\n");
}
testRoutes.post("/bank-analzye", upload.single("file"), (0, express_async_handler_1.default)(async (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
    }
    const rawCsvText = req.file.buffer.toString("utf-8");
    const detected = detectBankCsvFormat(rawCsvText);
    if (detected.format === "UNKNOWN") {
        res.status(400).json({
            error: "Unsupported CSV format"
        });
        return;
    }
    let cleanedCsv = rawCsvText;
    if (detected.format === "POSTBANK_UMSAETZE") {
        const stripped = stripToHeader(rawCsvText, "Buchungstag;Wert;Umsatzart;");
        if (!stripped) {
            res.status(400).json({
                error: "POSTBANK header not found"
            });
            return;
        }
        cleanedCsv = stripped;
    }
    if (detected.format === "STANDARD_EXPORT") {
        const stripped = stripToHeader(rawCsvText, "Bezeichnung Auftragskonto;");
        cleanedCsv = stripped || rawCsvText;
    }
    // Parse CSV
    const records = (0, sync_1.parse)(cleanedCsv, {
        delimiter: ";",
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true
    });
    // Take first 50 rows
    const first50 = records.slice(0, 50);
    // Convert back to CSV string for preview
    const headers = Object.keys(first50[0] || {});
    const csvPreview = headers.join(";") + "\n" +
        first50.map((row) => headers.map((h) => row[h] ?? "").join(";")).join("\n");
    res.status(200).json({
        csvText: csvPreview,
        attentionText: "Row Number;Issue Description;Failed Value\nRow 12;Missing Signature;N/A\nRow 18;Amount Mismatch;€50.00",
        downloadUrl: "/downloads/your-new-sanitized-file.csv"
    });
}));
exports.default = testRoutes;
