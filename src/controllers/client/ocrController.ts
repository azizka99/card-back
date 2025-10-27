import { Request, Response } from "express";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp, { Sharp } from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const TESSDATA_DIR = "/usr/share/tesseract-ocr/4.00/tessdata_best";
const ts = () => new Date().toISOString().slice(11, 19);

/* =========================
   IMAGE PREP (Sharp variants)
   ========================= */
async function prepVariants(inputPath: string) {
  const png = async (pipeline: Sharp): Promise<Buffer> => pipeline.png().toBuffer();
  const read = sharp(inputPath);

  const v1 = await png(
    read.clone().grayscale().linear(1.15, -8).resize({ width: 1600 }).threshold(205)
  );
  const v2 = await png(
    read.clone().grayscale().linear(1.25, -12).resize({ width: 1600 }).threshold(215)
  );
  const v3 = await png(read.clone().grayscale().linear(1.1, -5).resize({ width: 1800 }).sharpen(1));
  const v4 = await png(
    read.clone().grayscale().linear(1.35, -15).resize({ width: 2000 }).threshold(220)
  );
  const v5_neg = await png(
    read.clone().grayscale().linear(1.25, -12).resize({ width: 1600 }).threshold(215).negate()
  );
  const v6_boldx = await png(
    read
      .clone()
      .grayscale()
      .resize({ width: 1700 })
      .linear(1.25, -12)
      .threshold(210)
      .blur(0.6)
      .linear(1.25, -12)
      .threshold(215)
  );

  return { v1, v2, v3, v4, v5_neg, v6_boldx };
}

/* ===============
   OCR RUNNERS
   =============== */
async function writeTemp(buffer: Buffer, suffix: string): Promise<string> {
  const p = join(tmpdir(), `${suffix}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  await fs.writeFile(p, buffer);
  return p;
}
async function writePatternsFile(): Promise<string> {
  const content = `[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\n`;
  const p = join(tmpdir(), `patterns_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  await fs.writeFile(p, content, "utf8");
  return p;
}

async function runTesseractText(imgPath: string, psm: "6" | "7" | "13", patternsPath: string) {
  const args = [
    imgPath,
    "stdout",
    "--oem",
    "1",
    "--psm",
    psm,
    "-l",
    "eng",
    "-c",
    "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-",
    "-c",
    "load_system_dawg=0",
    "-c",
    "load_freq_dawg=0",
    "-c",
    "wordrec_enable_assoc=0",
    "-c",
    "user_defined_dpi=300",
    "--user-patterns",
    patternsPath,
    "--tessdata-dir",
    TESSDATA_DIR,
  ];
  const { stdout, stderr } = await execFileAsync("tesseract", args, {
    env: { ...process.env, OMP_THREAD_LIMIT: "2" },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return { out: (stdout || "").trim(), err: (stderr || "").trim() };
}

async function runTesseractTSV(imgPath: string, psm: "6" | "7" | "13", patternsPath: string) {
  // TSV = word-level boxes + confidences. We'll split the word into 15 chars.
  const args = [
    imgPath,
    "stdout",
    "tsv", // <- important
    "--oem",
    "1",
    "--psm",
    psm,
    "-l",
    "eng",
    "-c",
    "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-",
    "-c",
    "load_system_dawg=0",
    "-c",
    "load_freq_dawg=0",
    "-c",
    "wordrec_enable_assoc=0",
    "-c",
    "user_defined_dpi=300",
    "--user-patterns",
    patternsPath,
    "--tessdata-dir",
    TESSDATA_DIR,
  ];
  const { stdout, stderr } = await execFileAsync("tesseract", args, {
    env: { ...process.env, OMP_THREAD_LIMIT: "2" },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return { out: (stdout || "").trim(), err: (stderr || "").trim() };
}

/* ===========================
   PATTERN EXTRACT + NORMALIZE
   =========================== */
function normalizeSerialBusiness(serial: string): string {
  if (!serial) return "";
  let s = serial;
  s = s.replace(/O|o/gi, "0"); // O->0
  s = s.replace(/S|s/gi, "5"); // S->5
  s = s.replace(/1/g, "I"); // 1->I
  return s;
}

function extractActivationCode(rawText: string): string {
  if (!rawText) return "";
  const up = rawText.toUpperCase();

  // Strict pattern first
  const strict = /\b[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/;
  const m1 = up.match(strict);
  if (m1) return m1[0];

  // Tolerant (spaces inside/around)
  const tolerant = new RegExp(
    String.raw`(?:[A-Z0-9]\s?){5}\s*-\s*(?:[A-Z0-9]\s?){5}\s*-\s*(?:[A-Z0-9]\s?){5}`.replace(
      /\s+/g,
      ""
    )
  );
  const m2 = up.match(tolerant);
  if (m2) {
    const compact = m2[0].replace(/[^A-Z0-9]/g, "");
    if (compact.length >= 15) {
      return `${compact.slice(0, 5)}-${compact.slice(5, 10)}-${compact.slice(10, 15)}`;
    }
  }

  // Contiguous 15 fallback
  const onlyAN = up.replace(/[^A-Z0-9]+/g, "");
  if (onlyAN.length >= 15) {
    return `${onlyAN.slice(0, 5)}-${onlyAN.slice(5, 10)}-${onlyAN.slice(10, 15)}`;
  }
  return "";
}

/* ============================
   PER-GLYPH VOTING + RESCORING
   ============================ */
type Votes = Array<Map<string, number>>; // length 15 (no hyphens)
const AMBIG_PAIRS: Record<string, string> = { G: "6", "6": "G", Z: "2", "2": "Z", C: "0", "0": "C" };

function initVotes(): Votes {
  return Array.from({ length: 15 }, () => new Map<string, number>());
}
function addVote(votes: Votes, pos: number, ch: string, weight = 1) {
  if (pos < 0 || pos >= 15) return;
  if (!/^[A-Z0-9]$/.test(ch)) return;
  const m = votes[pos];
  m.set(ch, (m.get(ch) || 0) + weight);
}

function collapse15(s: string): string {
  return s.replace(/-/g, "");
}
function reinflate15(s15: string): string {
  return `${s15.slice(0, 5)}-${s15.slice(5, 10)}-${s15.slice(10, 15)}`;
}

function votesToString(votes: Votes): string {
  const chars: string[] = [];
  for (let i = 0; i < 15; i++) {
    let bestCh = "";
    let bestScore = -Infinity;
    for (const [ch, sc] of votes[i]) {
      if (sc > bestScore) {
        bestScore = sc;
        bestCh = ch;
      }
    }
    chars.push(bestCh || "X");
  }
  return reinflate15(chars.join(""));
}

function scoreCandidate(s: string): number {
  if (!s) return -1e9;
  let score = 0;
  if (/^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(s)) score += 50;
  const ambig = (c: string) => (s.match(new RegExp(c, "g")) || []).length;
  score -= ambig("G") * 0.5;
  score -= ambig("6") * 0.5;
  score -= ambig("Z") * 0.5;
  score -= ambig("2") * 0.5;
  score -= ambig("C") * 0.4;
  score -= ambig("0") * 0.4;
  if (s[5] === "-" && s[11] === "-") score += 5;
  return score;
}

function antiConfusionRescore(base: string, votes: Votes): string {
  // Only tweak positions where the top vote is ambiguous and the runner is close.
  const s15 = collapse15(base);
  const out: string[] = s15.split("");

  for (let i = 0; i < 15; i++) {
    const m = votes[i];
    if (m.size === 0) continue;

    // Sort choices by weight desc
    const ranked = Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    const second = ranked[1];

    if (!top) continue;
    const [topCh, topW] = top;

    // If topCh is from an ambiguous pair, compare with its counterpart (if present)
    if (AMBIG_PAIRS[topCh]) {
      const altCh = AMBIG_PAIRS[topCh];
      const altW = m.get(altCh) || 0;

      // If alternative is close enough, prefer LETTER over DIGIT in a near-tie:
      // Prefer G over 6, Z over 2, C over 0 when within 90% of the top.
      const nearTie = altW >= topW * 0.90;
      const preferLetters =
        (topCh === "6" && altCh === "G") ||
        (topCh === "2" && altCh === "Z") ||
        (topCh === "0" && altCh === "C");

      if (nearTie && preferLetters) {
        out[i] = altCh;
        continue;
      }
    }

    // Keep top
    out[i] = topCh;
    // If top missing (shouldn't), fill X
    if (!out[i]) out[i] = "X";
  }

  return reinflate15(out.join(""));
}

/* ============================
   MAIN CONTROLLER
   ============================ */
export async function ocrTesseract(req: Request, res: Response) {
  const toCleanup: string[] = [];
  let rawJpg = "";
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: "No file uploaded (field must be 'img')." });
    }

    // 1) Save upload
    rawJpg = join(tmpdir(), `roi_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    await fs.writeFile(rawJpg, req.file.buffer);
    toCleanup.push(rawJpg);
    console.log(`[OCR] ${ts()} 📸 Saved upload: ${rawJpg} bytes: ${req.file.buffer.length}`);

    // 2) Preprocess → variants
    const v = await prepVariants(rawJpg);
    const p1 = await writeTemp(v.v1, "prep.v1");
    const p2 = await writeTemp(v.v2, "prep.v2");
    const p3 = await writeTemp(v.v3, "prep.v3");
    const p4 = await writeTemp(v.v4, "prep.v4");
    const p5 = await writeTemp(v.v5_neg, "prep.v5_neg");
    const p6 = await writeTemp(v.v6_boldx, "prep.v6_boldx");
    toCleanup.push(p1, p2, p3, p4, p5, p6);
    console.log(`[OCR] ${ts()} ✅ Prepped: ${[p1, p2, p3, p4, p5, p6].join(", ")}`);

    // 3) Pattern prior file
    const patternsPath = await writePatternsFile();
    toCleanup.push(patternsPath);

    // 4) Runs (text + TSV)
    const runs: Array<{ img: string; psm: "6" | "7" | "13" }> = [
      { img: p2, psm: "6" },
      { img: p2, psm: "7" },
      { img: p1, psm: "6" },
      { img: p1, psm: "7" },
      { img: p3, psm: "6" },
      { img: p4, psm: "6" },
      { img: p5, psm: "6" },
      { img: p6, psm: "6" },
      { img: p2, psm: "13" },
    ];

    const candidatesText: string[] = [];
    const votes: Votes = initVotes();

    for (const r of runs) {
      // TEXT
      {
        console.log(`[OCR] ${ts()} 🧠 TXT PSM=${r.psm} on ${r.img}`);
        const { out, err } = await runTesseractText(r.img, r.psm, patternsPath);
        if (err) console.log(`[OCR] ${ts()} ⚠️ tesseract(txt) stderr: ${err.split("\n")[0] || ""}`);
        const snippet = out ? out.slice(0, 120).replace(/\s+/g, " ") : "<empty>";
        console.log(`[OCR] ${ts()} 🧾 TXT snippet: ${snippet}`);
        const extracted = extractActivationCode(out);
        if (extracted) {
          candidatesText.push(extracted);
          // Add votes (flat weight for text runs)
          const s15 = collapse15(extracted);
          for (let i = 0; i < 15; i++) addVote(votes, i, s15[i], 1.0);
        }
      }

      // TSV (word-level with confidence)
      {
        console.log(`[OCR] ${ts()} 🔬 TSV PSM=${r.psm} on ${r.img}`);
        const { out, err } = await runTesseractTSV(r.img, r.psm, patternsPath);
        if (err) console.log(`[OCR] ${ts()} ⚠️ tesseract(tsv) stderr: ${err.split("\n")[0] || ""}`);

        // Parse TSV rows
        // header: level page_num block_num par_num line_num word_num left top width height conf text
        const lines = out.split(/\r?\n/);
        const header = lines.shift() || "";
        const cols = header.split("\t");
        const idxConf = cols.indexOf("conf");
        const idxText = cols.indexOf("text");
        if (idxConf !== -1 && idxText !== -1) {
          for (const row of lines) {
            const parts = row.split("\t");
            if (parts.length !== cols.length) continue;
            const conf = Number(parts[idxConf]);
            if (isNaN(conf) || conf < 0) continue; // skip non-words (-1 conf)
            const text = (parts[idxText] || "").toUpperCase().trim();
            if (!text) continue;

            const ex = extractActivationCode(text);
            if (!ex) continue;

            // Weight by confidence (1.0 .. 2.0)
            const w = 1.0 + Math.max(0, Math.min(100, conf)) / 100.0;
            const s15 = collapse15(ex);
            for (let i = 0; i < 15; i++) addVote(votes, i, s15[i], w);
          }
        }
      }
    }

    // 5) Build a voted string
    const voted = votesToString(votes); // reinflated XXXXX-XXXXX-XXXXX
    const votedScore = scoreCandidate(voted);

    // 6) Compare with best of raw text candidates (fallback)
    const uniqText = Array.from(new Set(candidatesText));
    const bestText =
      uniqText
        .map((c) => ({ c, score: scoreCandidate(c) }))
        .sort((a, b) => b.score - a.score)[0]?.c || "";

    let pick = voted;
    if (scoreCandidate(bestText) > votedScore + 2) {
      pick = bestText;
    }

    // 7) Anti-confusion rescoring on the pick (use vote distributions)
    const debiased = antiConfusionRescore(pick, votes);

    // 8) Business mapping after extraction
    const cleaned = normalizeSerialBusiness(debiased);

    console.log(
      `[OCR] ${ts()} 🗳️ Candidates(text): ${uniqText.map((c) => c.replace(/-/g, "")).join(" | ") || "<none>"}`
    );
    console.log(`[OCR] ${ts()} 🧮 VOTED: ${voted}  | RESCORED: ${debiased}  | FINAL: ${cleaned}`);

    return res.json({ ok: true, rawText: uniqText.join("\n"), code: cleaned });
  } catch (err: any) {
    console.error(`[OCR] ${ts()} 💥 Error: ${err?.message || String(err)}`);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    const KEEP = process.env.KEEP_PREP_DEBUG === "1";
    if (!KEEP) {
      const unique = Array.from(new Set(toCleanup));
      await Promise.all(unique.map((p) => fs.unlink(p).catch(() => {})));
    } else {
      console.log(`[OCR] ${ts()} 🧰 KEEP_PREP_DEBUG=1 — not deleting temp files`);
    }
  }
}