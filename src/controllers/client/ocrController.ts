import { Request, Response } from "express";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const TESSDATA_DIR = "/usr/share/tesseract-ocr/4.00/tessdata_best";

/* ---------------- small log helpers ---------------- */
const now = () => new Date().toISOString().slice(11, 19);
const log = (...a: any[]) => console.log("[OCR]", now(), ...a);

/* ---------------- business helpers ---------------- */
const normalizeBusiness = (s: string) =>
  (s || "")
    .replace(/O|o/g, "0")
    .replace(/S|s/g, "5")
    .replace(/1/g, "I");

const wantFormat = (s: string) => /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(s);
const insertHyphens15 = (raw15: string) =>
  `${raw15.slice(0, 5)}-${raw15.slice(5, 10)}-${raw15.slice(10, 15)}`;

/* ---------------- tolerant extractor ---------------- */
function extractActivationCode(rawText: string): string {
  if (!rawText) return "";
  const up = String(rawText).toUpperCase().replace(/\r?\n/g, " ");
  const tolerant = new RegExp(
    String.raw`
      (?:
        (?:[A-Z0-9]\s?){5}
      )\s*-\s*
      (?:
        (?:[A-Z0-9]\s?){5}
      )\s*-\s*
      (?:
        (?:[A-Z0-9]\s?){5}
      )
    `.replace(/\s+/g, "")
  );
  const keepHyphens = up.replace(/[^\w-]+/g, " ").replace(/\s+/g, " ");
  const m = tolerant.exec(keepHyphens);
  if (!m) return "";

  const compact = m[0].replace(/[^A-Z0-9]/g, "");
  if (compact.length < 15) return "";
  return insertHyphens15(compact.slice(0, 15));
}

/* ---------------- tesseract runners ---------------- */
type PSM = "13" | "7" | "6";

async function runTesseract(filePath: string, psm: PSM, tag: string): Promise<string> {
  log(`🧠 Tesseract PSM=${psm} on ${tag}`);
  const args = [
    filePath, "stdout",
    "--oem", "1",
    "--psm", psm,
    "-l", "eng",
    "-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-",
    "-c", "tessedit_char_blacklist=abcdefghijklmnopqrstuvwxyz",
    "-c", "load_system_dawg=0",
    "-c", "load_freq_dawg=0",
    "-c", "user_defined_dpi=350",
    "--tessdata-dir", TESSDATA_DIR,
  ];
  const { stdout, stderr } = await execFileAsync("tesseract", args, {
    env: { ...process.env, OMP_THREAD_LIMIT: "2" },
    maxBuffer: 5 * 1024 * 1024,
  });
  if (stderr?.trim()) log("⚠️ Tesseract stderr:", stderr.trim().slice(0, 200));
  const out = (stdout || "").trim();
  log("🧾 Raw snippet:", out.slice(0, 120) || "<empty>");
  return out;
}

/* ---------------- voting across candidates ---------------- */
const AMBIG_PAIRS: Record<string, string> = {
  "6": "G", "G": "6",
  "2": "Z", "Z": "2",
  "0": "C", "C": "0",
  "8": "B", "B": "8",
  "7": "T", "T": "7",
  "D": "0" // sometimes D looks like closed 0
};

type Cand = { code15: string; source: string };

function pickByVoting(cands: Cand[]): string | null {
  // Keep only 15-char (no hyphens) candidates
  const raw15s = cands
    .map(c => c.code15.replace(/-/g, ""))
    .filter(s => /^[A-Z0-9]{15}$/.test(s));

  if (raw15s.length === 0) return null;

  // weights: favor PSM6, then PSM7, then PSM13; favor v2 slightly
  const weightOf = (source: string) => {
    let w = 1;
    if (source.includes("PSM=6")) w += 0.8;
    else if (source.includes("PSM=7")) w += 0.4;
    if (source.includes(".v2")) w += 0.4;
    if (source.includes(".v6_boldx")) w += 0.2;
    return w;
  };

  const perPos: Record<number, Record<string, number>> = {};
  for (let i = 0; i < 15; i++) perPos[i] = {};

  cands.forEach(({ code15, source }) => {
    const raw = code15.replace(/-/g, "");
    if (!/^[A-Z0-9]{15}$/.test(raw)) return;
    const baseW = weightOf(source);
    for (let i = 0; i < 15; i++) {
      const ch = raw[i];
      perPos[i][ch] = (perPos[i][ch] || 0) + baseW;
      // ambiguous shadow vote (small)
      const alt = AMBIG_PAIRS[ch];
      if (alt) perPos[i][alt] = (perPos[i][alt] || 0) + 0.35 * baseW;
    }
  });

  const chosen: string[] = [];
  for (let i = 0; i < 15; i++) {
    const tally = perPos[i];
    const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (!best) return null;
    chosen.push(best[0]);
  }

  return insertHyphens15(chosen.join(""));
}

/* ---------------- sharp pipeline ---------------- */
function base(img: sharp.Sharp): sharp.Sharp {
  return img
    .rotate()
    .grayscale()
    .extend({ top: 8, bottom: 8, left: 0, right: 0, background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .resize({ width: 1600, withoutEnlargement: false });
}

async function makeVariants(inputPath: string, baseOut: string): Promise<string[]> {
  const outs: string[] = [];

  // v1: threshold 210
  {
    const out = `${baseOut}.v1.png`;
    const buf = await base(sharp(inputPath))
      .sharpen(1)
      .linear(1.2, -10)
      .threshold(210)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf); outs.push(out); log("✅ Prepped V1:", out);
  }
  // v2: soft, no threshold (often best)
  {
    const out = `${baseOut}.v2.png`;
    const buf = await base(sharp(inputPath))
      .sharpen(0.5)
      .linear(1.1, -5)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf); outs.push(out); log("✅ Prepped V2:", out);
  }
  // v3: threshold 190
  {
    const out = `${baseOut}.v3.png`;
    const buf = await base(sharp(inputPath))
      .sharpen(0.8)
      .linear(1.15, -8)
      .threshold(190)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf); outs.push(out); log("✅ Prepped V3:", out);
  }
  // v4: threshold 225
  {
    const out = `${baseOut}.v4.png`;
    const buf = await base(sharp(inputPath))
      .sharpen(1.2)
      .linear(1.25, -12)
      .threshold(225)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf); outs.push(out); log("✅ Prepped V4:", out);
  }
  // v5: negative + threshold
  {
    const out = `${baseOut}.v5_neg.png`;
    const buf = await base(sharp(inputPath))
      .negate()
      .linear(1.2, -10)
      .threshold(210)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf); outs.push(out); log("✅ Prepped V5 (neg):", out);
  }
  // v6: bold (3x3)
  {
    const out = `${baseOut}.v6_boldx.png`;
    const kernel: any = { width: 3, height: 3, kernel: [
      1,1,1,
      1,1,1,
      1,1,1
    ], scale: 1 };
    const buf = await base(sharp(inputPath))
      .linear(1.15, -8)
      .threshold(205)
      .convolve(kernel as any)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf); outs.push(out); log("✅ Prepped V6 (bold-x):", out);
  }

  return outs;
}

/* ---------------- controller (ensemble voting) ---------------- */
export async function ocrTesseract(req: Request, res: Response) {
  let tmpPath = "";
  const toCleanup: string[] = [];
  try {
    if (!req.file?.buffer) {
      log("❌ No file uploaded.");
      return res.status(400).json({ ok: false, error: "No file uploaded (field must be 'img')." });
    }

    // save upload
    tmpPath = join(tmpdir(), `roi_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    await fs.writeFile(tmpPath, req.file.buffer);
    log("📸 Saved upload:", tmpPath, "bytes:", req.file.buffer.length);

    // preprocess
    const baseOut = tmpPath.replace(/\.jpg$/i, ".prep");
    const variants = await makeVariants(tmpPath, baseOut);
    toCleanup.push(...variants);

    // run all variants/psms -> collect candidates
    const psms: PSM[] = ["13", "7", "6"];
    const allCandidates: { code15: string; source: string }[] = [];
    let firstGoodRaw = "";
    let firstGoodPretty = "";

    for (const v of variants) {
      const tag = v.split("/").pop() || v;
      for (const p of psms) {
        const raw = await runTesseract(v, p, tag);
        const codePretty = extractActivationCode(raw);
        if (codePretty) {
          const code15 = codePretty.replace(/-/g, "");
          allCandidates.push({ code15, source: `${tag} PSM=${p}` });
          if (!firstGoodPretty) {
            firstGoodRaw = raw;
            firstGoodPretty = codePretty;
          }
        }
      }
    }

    // fallback: if nothing extracted at all
    if (allCandidates.length === 0) {
      log("⚠️ No candidates from any variant/psm.");
      return res.json({ ok: true, rawText: "", code: "" });
    }

    // ensemble vote
    const voted = pickByVoting(allCandidates) || firstGoodPretty;
    const cleaned = normalizeBusiness(voted);

    log("🗳️ Candidates:", allCandidates.map(c => `${c.code15} [${c.source}]`).join(" | "));
    log("✅ Final cleaned code:", cleaned || "<none>");

    return res.json({
      ok: true,
      rawText: firstGoodRaw,
      code: cleaned,
      debug: {
        candidates: allCandidates,
        voted: voted,
      }
    });
  } catch (err: any) {
    log("💥 Error:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    // cleanup everything (original + variants)
    const unique = Array.from(new Set(toCleanup.concat(tmpPath ? [tmpPath] : [])));
    await Promise.all(unique.map(p => fs.unlink(p).catch(() => {})));
  }
}