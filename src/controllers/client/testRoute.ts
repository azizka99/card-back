import express from "express";
import expressAsyncHandler from "express-async-handler";
import multer from "multer";
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
function extractKundennummern(verwendungszweckRaw: string) {
    const original = String(verwendungszweckRaw ?? "");
    let text = original
        .replace(/^\uFEFF/, "")
        .replace(/\s+/g, " ")
        .trim();

    if (!text) return [];

    // Remove common trailing punctuation so "32113 ." becomes "32113"
    const textTrimmedPunct = text.replace(/[.,;:!]+$/g, "").trim();

    // Exclude obvious pure amounts like "2.449.877,11" or "123,45"
    const looksLikeAmount =
        /^\d{1,3}(\.\d{3})+,\d{2}$/.test(textTrimmedPunct) ||
        /^\d+,\d{2}$/.test(textTrimmedPunct);
    if (looksLikeAmount) return [];

    const found = new Set();

    // 1) Keyword-anchored patterns (robust, accepts weird punctuation/case)
    // Also catches weird "Kundennr.: 17494.Handy-Shop"
    const keywordRegexes = [
        // kundennr / kundennummer / kunden nr / kunde / kdnr / knd
        /\b(kundennr|kundennummer|kunden\s*nr|kunde|kdnr|knd)\b\s*[:.#,\-]?\s*(\d{1,5})\b/gi,
        // KD 12345 / KD-12345 / KD-NR.12345 / KDNR 12345
        /\b(kd)\b\s*[-\s]*(nr)?\s*[:.#,\-]?\s*(\d{1,5})\b/gi,
        // Ku Nr 12345 / KNr.12345
        /\b(ku\s*nr|knr)\b\s*[:.#,\-]?\s*(\d{1,5})\b/gi,
        // Handle common typo you showed: "Kundenn, 35580" / "Kundenn 35580"
        /\b(kundenn)\b\s*[:.#,\-]?\s*(\d{1,5})\b/gi,
    ];

    for (const rx of keywordRegexes) {
        let m;
        while ((m = rx.exec(text)) !== null) {
            const num = (m[3] ?? m[2] ?? "").trim();
            if (num && num.length <= 5) found.add(num);
        }
    }

    // 2) Special: number followed by (amount) => "7082 (300)"
    {
        const rx = /\b(\d{1,5})\s*\(\s*\d+(?:[.,]\d+)?\s*\)/g;
        let m;
        while ((m = rx.exec(text)) !== null) {
            found.add(m[1]);
        }
    }

    // 3) Standalone max-5-digit line ALWAYS counts (your rule)
    if (/^\d{1,5}$/.test(textTrimmedPunct)) {
        found.add(textTrimmedPunct);
    }

    // 4) Fallback token scan (to catch "guthaben Kaufen 23284", "34055 Februar")
    // Only if still nothing found
    if (found.size === 0) {
        // If the line is clearly about invoices/IDs/dates, do NOT extract random numbers
        const hardBlock = /\b(rg|rechn|invoice|kassennr|karte|iban|bic|mandatsreferenz|gläubiger|glaeubiger|datum|uhr|saldo|umsatzart)\b/i;
        if (!hardBlock.test(text)) {
            // Extract all 1–5 digit tokens
            const tokenRx = /\b(\d{1,5})\b/g;
            let m;
            while ((m = tokenRx.exec(text)) !== null) {
                found.add(m[1]);
            }
        }
    }

    return Array.from(found);
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

        const attentionRows = [];

        for (const row of records as any) {
            const vz = row["Verwendungszweck"] ?? "";
            const nums = extractKundennummern(vz);

            row.kundennummer_extracted = nums[0] ?? "";
            row.kundennummer_extracted_all = nums.join(",");

            if (nums.length === 0) attentionRows.push(String(vz));
        }

        const attentionText = attentionRows.slice(0, 50).join("\n");

        const csvText = toCsvPreview(records, 50);

         res.status(200).json({
            csvText,
            attentionText,
            downloadUrl: "/downloads/your-new-sanitized-file.csv",
        });
        return;
    }

    const csvText = toCsvPreview(records, 50);

    res.status(200).json({
        // format: detected.format,
        csvText,
        attentionText: csvText.split("\n")[1],
        downloadUrl: "/downloads/your-new-sanitized-file.csv",
    });
}));

export default testRoutes;