import express from "express";
import expressAsyncHandler from "express-async-handler";
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
import { parse } from "csv-parse/sync";
const testRoutes = express.Router();


testRoutes.get("/bank", expressAsyncHandler(async (req, res) => {

    res.render("sanitazeBank")
}));

function detectBankCsvFormat(rawCsvText: string) {
    const text = rawCsvText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = text.split("\n").slice(0, 40).map(l => l.trim()).filter(Boolean);

    const idxA = lines.findIndex(l =>
        l.startsWith("Buchungstag;") &&
        l.includes("Umsatzart;") &&
        l.includes("Verwendungszweck;")
    );

    if (idxA !== -1) return { format: "POSTBANK_UMSAETZE" };

    const idxB = lines.findIndex(l =>
        l.startsWith("Bezeichnung Auftragskonto;") &&
        l.includes("Verwendungszweck;") &&
        l.includes("Betrag;")
    );

    if (idxB !== -1) return { format: "STANDARD_EXPORT" };

    return { format: "UNKNOWN" };
}

function stripToHeader(rawCsvText: string, headerStartsWith: string) {
    const text = rawCsvText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = text.split("\n");

    const headerIndex = lines.findIndex(l =>
        (l || "").trim().startsWith(headerStartsWith)
    );

    if (headerIndex === -1) return null;

    return lines.slice(headerIndex).join("\n");
}

testRoutes.post("/bank-analzye", upload.single("file"), expressAsyncHandler(async (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return
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
    const records = parse(cleanedCsv, {
        delimiter: ";",
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true
    });

    // Take first 50 rows
    const first50 = records.slice(0, 50);

    // Convert back to CSV string for preview
    const headers = Object.keys(first50[0] || {});
    const csvPreview =
        headers.join(";") + "\n" +
        first50.map((row: any) =>
            headers.map((h) => row[h] ?? "").join(";")
        ).join("\n");

    res.status(200).json({
        csvText: csvPreview,
        downloadUrl: "/downloads/your-new-sanitized-file.csv"
    });
}));

export default testRoutes;