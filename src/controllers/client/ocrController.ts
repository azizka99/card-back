import { Request, Response } from "express";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const TESSDATA_DIR = "/usr/share/tesseract-ocr/4.00/tessdata_best";
const ts = () => new Date().toISOString().slice(11, 19);

/* ---------------- Sharp variants ---------------- */
async function prepVariants(inputPath: string) {
  const png = async (pipeline: sharp.Sharp) => pipeline.png().toBuffer();
  const read = sharp(inputPath);

  // v1: BW, light threshold
  const v1 = await png(
    read.clone().grayscale().linear(1.15, -8).resize({ width: 1600 }).threshold(205)
  );

  // v2: BW, stronger threshold
  const v2 = await png(
    read.clone().grayscale().linear(1.25, -12).resize({ width: 1600 }).threshold(215)
  );

  // v3: softer (avoid over-threshold)
  const v3 = await png(
    read.clone().grayscale().linear(1.1, -5).resize({ width: 1800 }).sharpen(1)
  );

  // v4: high-res and hard threshold
  const v4 = await png(
    read.clone().grayscale().linear(1.35, -15).resize({ width: 2000 }).threshold(220)
  );

  // v5: inverted
  const v5_neg = await png(
    read.clone().grayscale().linear(1.25, -12).resize({ width: 1600 }).threshold(215).negate()
  );

  // v6: slight bolding
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

/* ---------------- Patterns & temp helpers ---------------- */
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

/* ---------------- Tesseract runners ---------------- */
// TXT to stdout (normal recognition)
async function runTesseractTXT(imgPath: string, psm: "6" | "7" | "13", patternsPath: string) {
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
    maxBuffer: 8 * 1024 * 1024,
  });
  return { out: (stdout || "").trim(), err: (stderr || "").trim() };
}

// TSV to stdout (box-level info) — options BEFORE "tsv"
async function runTesseractTSV(imgPath: string, psm: "6" | "7" | "13", patternsPath: string) {
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
    "tsv",
  ];
  const { stdout, stderr } = await execFileAsync("tesseract", args, {
    env: { ...process.env, OMP_THREAD_LIMIT: "2" },
    maxBuffer: 8 * 1024 * 1024,
  });
  return { out: (stdout || "").trim(), err: (stderr || "").trim() };
}

/* ---------------- Extraction & scoring ---------------- */
function extractActivationCode(rawText: string): string {
  if (!rawText) return "";
  const up = rawText.toUpperCase();

  const exact = /\b[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/;
  const m1 = up.match(exact);
  if (m1) return m1[0];

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

  const onlyAN = up.replace(/[^A-Z0-9]+/g, "");
  if (onlyAN.length >= 15) {
    return `${onlyAN.slice(0, 5)}-${onlyAN.slice(5, 10)}-${onlyAN.slice(10, 15)}`;
  }
  return "";
}

function scoreCandidate(s: string): number {
  if (!/^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(s)) return -1e9;
  let score = 50; // shape bonus

  const ambigPenalty: Record<string, number> = {
    G: 0.5,
    "6": 0.5,
    Z: 0.5,
    "2": 0.5,
    C: 0.4,
    "0": 0.4,
    B: 0.5,
    "8": 0.5,
    O: 0.4,
    D: 0.4,
  };
  for (const [k, p] of Object.entries(ambigPenalty)) {
    const n = (s.match(new RegExp(k, "g")) || []).length;
    score -= n * p;
  }

  // Prefer a mix of letters/digits per block
  const blocks = s.split("-");
  for (const b of blocks) {
    const letters = (b.match(/[A-Z]/g) || []).length;
    const digits = (b.match(/[0-9]/g) || []).length;
    if (letters > 0 && digits > 0) score += 3;
  }

  // Light penalties for suspicious endings
  const last = blocks[2];
  if (/Z2Z$/.test(last)) score -= 2;
  if (/^\d{5}$/.test(last)) score -= 2;

  // Small bonus for hyphens in correct places
  if (s[5] === "-" && s[11] === "-") score += 5;

  return score;
}

const CONFUSIONS: Record<string, string[]> = {
  "6": ["G"],
  G: ["6"],
  "2": ["Z"],
  Z: ["2"],
  "0": ["O", "D", "Q", "C"],
  O: ["0"],
  D: ["0"],
  Q: ["0"],
  C: ["0"],
  "8": ["B"],
  B: ["8"],
  "1": ["I"],
  I: ["1"],
  "5": ["S"],
  S: ["5"],
};

function* oneFlipNeighbors(s: string) {
  for (let i = 0; i < s.length; i++) {
    const alts = CONFUSIONS[s[i]] || [];
    for (const a of alts) {
      yield s.slice(0, i) + a + s.slice(i + 1);
    }
  }
}

function rescoreWithConfusions(top: string): string {
  let best = top,
    bestScore = scoreCandidate(top);
  for (const cand of oneFlipNeighbors(top)) {
    const sc = scoreCandidate(cand);
    if (sc > bestScore) {
      best = cand;
      bestScore = sc;
    }
  }
  return best;
}

// Try “business rule” variants as candidates, then score them (no global mutation)
function businessVariants(s: string): string[] {
  const up = s.toUpperCase();
  const set = new Set<string>();
  set.add(up);
  set.add(up.replace(/O/g, "0"));
  set.add(up.replace(/S/g, "5"));
  set.add(up.replace(/1/g, "I"));
  set.add(up.replace(/O/g, "0").replace(/1/g, "I"));
  return Array.from(set);
}

// Per-glyph voting across many 17-char candidates (positions 5 and 11 are hyphens)
function voteCandidates(codes: string[]): string {
  if (!codes.length) return "";
  const L = 17;
  const posCounts: Array<Map<string, number>> = Array.from({ length: L }, () => new Map());
  for (const c of codes) {
    if (!/^[A-Z0-9-]{17}$/.test(c)) continue;
    for (let i = 0; i < L; i++) {
      const ch = i === 5 || i === 11 ? "-" : c[i];
      if (!ch) continue;
      const m = posCounts[i];
      m.set(ch, (m.get(ch) || 0) + 1);
    }
  }
  const out = Array<string>(L);
  for (let i = 0; i < L; i++) {
    if (i === 5 || i === 11) {
      out[i] = "-";
      continue;
    }
    const m = posCounts[i];
    let bestCh = "";
    let bestN = -1;
    for (const [ch, n] of m) {
      if (ch === "-") continue;
      if (n > bestN) {
        bestN = n;
        bestCh = ch;
      }
    }
    out[i] = bestCh || ""; // may be empty if no votes
  }
  const voted = out.join("");
  return /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(voted) ? voted : "";
}

/* ---------------- Controller ---------------- */
export async function ocrTesseract(req: Request, res: Response) {
  const toCleanup: string[] = [];
  let rawJpg = "";
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: "No file uploaded (field must be 'img')." });
    }

    // Save original
    rawJpg = join(tmpdir(), `roi_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    await fs.writeFile(rawJpg, req.file.buffer);
    toCleanup.push(rawJpg);
    console.log(`[OCR] ${ts()} 📸 Saved upload: ${rawJpg} bytes: ${req.file.buffer.length}`);

    // Build Sharp variants
    const v = await prepVariants(rawJpg);

    // Persist variants for Tesseract
    const p1 = await writeTemp(v.v1, "prep.v1");
    const p2 = await writeTemp(v.v2, "prep.v2");
    const p3 = await writeTemp(v.v3, "prep.v3");
    const p4 = await writeTemp(v.v4, "prep.v4");
    const p5 = await writeTemp(v.v5_neg, "prep.v5_neg");
    const p6 = await writeTemp(v.v6_boldx, "prep.v6_boldx");
    toCleanup.push(p1, p2, p3, p4, p5, p6);

    console.log(`[OCR] ${ts()} ✅ Prepped: ${[p1, p2, p3, p4, p5, p6].join(", ")}`);

    // Patterns file
    const patternsPath = await writePatternsFile();
    toCleanup.push(patternsPath);

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

    const rawCandidates: string[] = [];

    // Collect TXT candidates
    for (const r of runs) {
      console.log(`[OCR] ${ts()} 🧠 TXT PSM=${r.psm} on ${r.img}`);
      const { out, err } = await runTesseractTXT(r.img, r.psm, patternsPath);
      if (err) {
        const oneLine = err.split("\n").slice(0, 4).join(" ");
        console.log(`[OCR] ${ts()} ⚠️ tesseract(txt) stderr: ${oneLine}`);
      }
      const snippet = out ? out.slice(0, 120).replace(/\s+/g, " ") : "<empty>";
      console.log(`[OCR] ${ts()} 🧾 TXT snippet: ${snippet}`);

      const extracted = extractActivationCode(out);
      console.log(`[OCR] ${ts()} 🔎 Extracted (${r.img}, PSM=${r.psm}): ${extracted || "<none>"}`);
      if (extracted) rawCandidates.push(extracted);
    }

    // Optionally: run one TSV just to ensure args are correct and available (not used below)
    try {
      const sample = runs[0];
      const { err: tsvErr } = await runTesseractTSV(sample.img, sample.psm, patternsPath);
      if (tsvErr) {
        const oneLine = tsvErr.split("\n").slice(0, 2).join(" ");
        console.log(`[OCR] ${ts()} 🔬 TSV available but stderr: ${oneLine}`);
      }
    } catch (e: any) {
      console.log(`[OCR] ${ts()} 🔬 TSV call failed (non-fatal): ${e?.message || e}`);
    }

    // Dedup and quick exit
    const uniq = Array.from(new Set(rawCandidates));
    console.log(
      `[OCR] ${ts()} 🗳️ Candidates(text): ${uniq.length ? uniq.map(c => c.replace(/-/g, "")).join(" ") : "<none>"}`
    );
    if (uniq.length === 0) {
      return res.json({ ok: true, rawText: "", code: "" });
    }

    // 1) Per-glyph voting across candidates
    const voted = voteCandidates(uniq);

    // 2) Expand with “business rule” variants (no global mutation)
    const allForScoring = new Set<string>();
    for (const c of uniq) for (const v2 of businessVariants(c)) allForScoring.add(v2);
    if (voted) for (const v2 of businessVariants(voted)) allForScoring.add(v2);

    // 3) Pick best by scoring
    let best = { c: "", score: -1e9 };
    for (const c of allForScoring) {
      const sc = scoreCandidate(c);
      if (sc > best.score) best = { c, score: sc };
    }

    // 4) Anti-confusion rescoring on the top hypothesis
    const rescored = rescoreWithConfusions(best.c);

    // Log & return
    console.log(
      `[OCR] ${ts()} 🧮 VOTED: ${voted || "<none>"}  | RESCORED: ${rescored}  | FINAL: ${rescored}`
    );

    return res.json({
      ok: true,
      rawText: uniq.join("\n"),
      code: rescored,
    });
  } catch (err: any) {
    console.error(`[OCR] ${ts()} 💥 Error: ${err?.message || String(err)}`);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    const KEEP = process.env.KEEP_PREP_DEBUG === "1";
    if (!KEEP) {
      const unique = Array.from(new Set(toCleanup));
      await Promise.all(unique.map(p => fs.unlink(p).catch(() => {})));
    } else {
      console.log(`[OCR] ${ts()} 🧰 KEEP_PREP_DEBUG=1 — not deleting temp files`);
    }
  }
}