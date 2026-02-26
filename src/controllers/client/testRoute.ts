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
    const text = original
        .replace(/^\uFEFF/, "")
        .replace(/\s+/g, " ")
        .trim();

    if (!text) return [];

    // Hard excludes: if the row looks like a pure large money number "2.449.877,11"
    // or contains too many separators typical for amounts, we don't treat it as Kundennr-only line
    const looksLikeAmount =
        /^\d{1,3}(\.\d{3})+,\d{2}$/.test(text) || // 2.449.877,11
        /^\d+,\d{2}$/.test(text);                // 123,45
    if (looksLikeAmount) return [];

    const found = new Set();

    // 1) Keyword-anchored patterns (high confidence)
    // Supports: Kundennr, Kundennummer, KUNDENNR, Kunden nr, Kunde, KD, KD-NR, KD-xxxxx, kdnr, knd, Ku Nr, KNr, etc.
    const keywordRegexes = [
        // kundennr / kundennummer / kunde / kdnr / knd (with optional punctuation)
        /\b(kundennr|kundennummer|kunden\s*nr|kunde|kdnr|knd)\b\s*[:.#\-]?\s*(\d{1,5})\b/gi,
        // KD 12345 / KD-12345 / KD-NR.12345 / KDNR 12345
        /\b(kd)\b\s*[-\s]*(nr)?\s*[:.#\-]?\s*(\d{1,5})\b/gi,
        // Ku Nr 12345 / KNr.12345
        /\b(ku\s*nr|knr)\b\s*[:.#\-]?\s*(\d{1,5})\b/gi,
    ];

    for (const rx of keywordRegexes) {
        let m;
        while ((m = rx.exec(text)) !== null) {
            const num = (m[3] ?? m[2] ?? "").trim();
            if (num && num.length <= 5) found.add(num);
        }
    }

    // 2) Special: numbers followed by (amount) like "7082 (300)" — capture the left number
    // This will also catch both sides in "7082 (300) und 6663 (100)"
    {
        const rx = /\b(\d{1,5})\s*\(\s*\d+(?:[.,]\d+)?\s*\)/g;
        let m;
        while ((m = rx.exec(text)) !== null) {
            const num = m[1];
            if (num && num.length <= 5) found.add(num);
        }
    }

    // 3) Fallback: if the whole text is just a 1–5 digit number (like "36770" or "26614")
    // But avoid common non-kundennr contexts like "Rg. 222542" (6 digits won't pass anyway)
    if (/^\d{1,5}$/.test(text)) {
        found.add(text);
    }

    // 4) Extra safety excludes: avoid KassenNr / Karte numbers if they accidentally match
    // (Your max 5 digits helps already, but keep it anyway)
    // If the ONLY matches came from a context that contains kassennr/karte, remove them.
    const badContext = /\b(kassennr|karte)\b/i.test(text);
    if (badContext && found.size > 0) {
        // If you want: only remove if keyword not used:
        const hasKundenKeyword = /\b(kundennr|kundennummer|kdnr|knd|kd|ku\s*nr|knr|kunde)\b/i.test(text);
        if (!hasKundenKeyword) {
            // likely not a customer number
            return [];
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

        const attentionRows = []; // store original rows where no kunden nr found

        for (const row of records as any) {
            const vz = row["Verwendungszweck"] ?? "";

            const kundenNums = extractKundennummern(vz); // returns [] or ["7082","6663",...]

            if (kundenNums.length === 0) {
                attentionRows.push(vz);
                row.kundennummer_extracted = "";       // keep empty
                row.kundennummer_extracted_all = "";   // keep empty
            } else {
                row.kundennummer_extracted = kundenNums[0];          // first one
                row.kundennummer_extracted_all = kundenNums.join(","); // all (multi)
            }
        }

        // Build preview CSV (first 50 rows) as you already do:
        const csvText = toCsvPreview(records, 50);

        // Build attentionText: show first N rows that had no Kundennummer
        const attentionText = attentionRows.slice(0, 20).join("\n");

        // Response
        res.status(200).json({
            csvText,
            attentionText, // <-- rows with NO kundennummer extracted (Verwendungszweck text)
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