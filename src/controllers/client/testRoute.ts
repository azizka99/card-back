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
        l.startsWith("Buchungstag;") && l.includes("Umsatzart;") && l.includes("Verwendungszweck;")
    );
    if (idxA !== -1) return { format: "POSTBANK_UMSAETZE" };

    const idxB = lines.findIndex(l =>
        l.startsWith("Bezeichnung Auftragskonto;") && l.includes("Verwendungszweck;") && l.includes("Betrag;")
    );
    if (idxB !== -1) return { format: "STANDARD_EXPORT" };

    return { format: "UNKNOWN" };
}

function stripToHeader(rawCsvText: string, headerStartsWith: string) {
    const text = rawCsvText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = text.split("\n");
    const headerIndex = lines.findIndex(l => (l || "").trim().startsWith(headerStartsWith));
    if (headerIndex === -1) return null;
    return lines.slice(headerIndex).join("\n");
}

function toCsvPreview(rows: any, maxRows = 50) {
    const first = rows.slice(0, maxRows);
    if (first.length === 0) return "";

    const headers = Object.keys(first[0]);
    const escape = (v: string) => {
        const s = String(v ?? "");
        // minimal CSV escaping for ';' exports
        if (/[;"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
    };

    return (
        headers.join(";") + "\n" +
        first.map((r: string) => headers.map((h: any) => escape(r[h])).join(";")).join("\n")
    );
}
testRoutes.post("/bank-analzye", upload.single("file"), expressAsyncHandler(async (req, res) => {
    if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }

    const rawCsvText = req.file.buffer.toString("utf-8");
    const detected = detectBankCsvFormat(rawCsvText);

    if (detected.format === "UNKNOWN") {
        res.status(400).json({ error: "Unsupported CSV format" });
        return
    }

    let cleanedCsv = rawCsvText;

    if (detected.format === "POSTBANK_UMSAETZE") {
        const stripped = stripToHeader(rawCsvText, "Buchungstag;Wert;Umsatzart;");
        if (!stripped) { res.status(400).json({ error: "POSTBANK header not found" }); return }
        cleanedCsv = stripped;
    } else if (detected.format === "STANDARD_EXPORT") {
        cleanedCsv = stripToHeader(rawCsvText, "Bezeichnung Auftragskonto;") || rawCsvText;
    }

    const records = parse(cleanedCsv, {
        delimiter: ";",
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        bom: true,
        trim: true,
    });

    // ✅ Drop unwanted columns ONLY for Postbank
    if (detected.format === "POSTBANK_UMSAETZE") {
        const DROP = new Set([
            "Buchungstag",
            "Wert",
            "Mandatsreferenz",
            "Gläubiger ID",
            "Fremde Gebühren",
            "Abweichender Empfänger",
            "Anzahl der Aufträge",
            "Anzahl der Schecks",
            "Soll",
            "Haben",
            "Währung",
        ]);

        for (const row of records as any) {
            for (const key of Object.keys(row)) {
                if (DROP.has(key)) delete row[key];
            }
        }
    }

    const csvText = toCsvPreview(records, 50);

    res.status(200).json({
        // format: detected.format,
        csvText,
        attentionText:csvText.split("\n")[1],
        downloadUrl: "/downloads/your-new-sanitized-file.csv",
    });
}));

export default testRoutes;