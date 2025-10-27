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
    read.clone()
      .grayscale()
      .linear(1.15, -8)
      .resize({ width: 1600 })
      .threshold(205)
  );

  // v2: BW, stronger threshold (often best)
  const v2 = await png(
    read.clone()
      .grayscale()
      .linear(1.25, -12)
      .resize({ width: 1600 })
      .threshold(215)
  );

  // v3: softer (avoid over-threshold)
  const v3 = await png(
    read.clone()
      .grayscale()
      .linear(1.1, -5)
      .resize({ width: 1800 })
      .sharpen(1)
  );

  // v4: high-res and hard threshold
  const v4 = await png(
    read.clone()
      .grayscale()
      .linear(1.35, -15)
      .resize({ width: 2000 })
      .threshold(220)
  );

  // v5: inverted (sometimes helps)
  const v5_neg = await png(
    read.clone()
      .grayscale()
      .linear(1.25, -12)
      .resize({ width: 1600 })
      .threshold(215)
      .negate()
  );

  // v6: slight bolding (dilate by blurring + threshold again)
  const v6_boldx = await png(
    read.clone()
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

/* ---------------- Helpers ---------------- */
function normalizeSerialBusiness(serial: string): string {
  if (!serial) return "";
  let s = serial;
  s = s.replace(/O|o/gi, "0"); // O->0
  s = s.replace(/S|s/gi, "5"); // S->5
  s = s.replace(/1/g, "I");    // 1->I
  return s;
}

function extractActivationCode(rawText: string): string {
  if (!rawText) return "";
  const up = rawText.toUpperCase();

  // Prefer exact pattern first (we’re also feeding this pattern to Tesseract)
  const exact = /\b[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/;
  const m1 = up.match(exact);
  if (m1) return m1[0];

  // Tolerant: allow spaces/noise inside blocks
  const tolerant = new RegExp(
    String.raw`
      (?:[A-Z0-9]\s?){5}\s*-\s*(?:[A-Z0-9]\s?){5}\s*-\s*(?:[A-Z0-9]\s?){5}
    `.replace(/\s+/g, "")
  );
  const m2 = up.match(tolerant);
  if (m2) {
    const compact = m2[0].replace(/[^A-Z0-9]/g, "");
    if (compact.length >= 15) {
      return `${compact.slice(0,5)}-${compact.slice(5,10)}-${compact.slice(10,15)}`;
    }
  }

  // Fallback: first contiguous 15
  const onlyAN = up.replace(/[^A-Z0-9]+/g, "");
  if (onlyAN.length >= 15) {
    return `${onlyAN.slice(0,5)}-${onlyAN.slice(5,10)}-${onlyAN.slice(10,15)}`;
  }
  return "";
}

function scoreCandidate(s: string): number {
  // Simple heuristic: penalize unlikely runs of very similar glyphs which cause G/6, Z/2, C/0 flops.
  if (!s) return -1e9;
  let score = 0;
  // bonus for matching exact length/shape
  if (/^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(s)) score += 50;

  // mild penalties for repeated ambiguous glyphs
  const ambig = (c: string) => (s.match(new RegExp(c, "g")) || []).length;
  score -= ambig("G") * 0.5;
  score -= ambig("6") * 0.5;
  score -= ambig("Z") * 0.5;
  score -= ambig("2") * 0.5;
  score -= ambig("C") * 0.4;
  score -= ambig("0") * 0.4;

  // tiny bonus for having at least one hyphen in the right places
  if (s[5] === "-" && s[11] === "-") score += 5;

  return score;
}

async function writeTemp(buffer: Buffer, suffix: string): Promise<string> {
  const p = join(tmpdir(), `${suffix}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  await fs.writeFile(p, buffer);
  return p;
}

async function writePatternsFile(): Promise<string> {
  // Tesseract user_patterns syntax supports regex-like lines. Keep it very strict.
  const content = `[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\n`;
  const p = join(tmpdir(), `patterns_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  await fs.writeFile(p, content, "utf8");
  return p;
}

async function runTesseract(imgPath: string, psm: "6" | "7" | "13", patternsPath: string) {
  const args = [
    imgPath, "stdout",
    "--oem", "1",
    "--psm", psm,
    "-l", "eng",
    // STRONG priors:
    "-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-",
    "-c", "load_system_dawg=0",
    "-c", "load_freq_dawg=0",
    "-c", "wordrec_enable_assoc=0",
    "-c", "user_defined_dpi=300",
    "--user-patterns", patternsPath,
    "--tessdata-dir", TESSDATA_DIR,
  ];
  const { stdout, stderr } = await execFileAsync("tesseract", args, {
    env: { ...process.env, OMP_THREAD_LIMIT: "2" },
    maxBuffer: 8 * 1024 * 1024,
  });
  return { out: (stdout || "").trim(), err: (stderr || "").trim() };
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

    // Persist them (Tesseract needs files)
    const p1 = await writeTemp(v.v1, "prep.v1");
    const p2 = await writeTemp(v.v2, "prep.v2");
    const p3 = await writeTemp(v.v3, "prep.v3");
    const p4 = await writeTemp(v.v4, "prep.v4");
    const p5 = await writeTemp(v.v5_neg, "prep.v5_neg");
    const p6 = await writeTemp(v.v6_boldx, "prep.v6_boldx");
    toCleanup.push(p1, p2, p3, p4, p5, p6);

    console.log(`[OCR] ${ts()} ✅ Prepped V1: ${p1}`);
    console.log(`[OCR] ${ts()} ✅ Prepped V2: ${p2}`);
    console.log(`[OCR] ${ts()} ✅ Prepped V3: ${p3}`);
    console.log(`[OCR] ${ts()} ✅ Prepped V4: ${p4}`);
    console.log(`[OCR] ${ts()} ✅ Prepped V5 (neg): ${p5}`);
    console.log(`[OCR] ${ts()} ✅ Prepped V6 (bold-x): ${p6}`);

    // Patterns file (very important!)
    const patternsPath = await writePatternsFile();
    toCleanup.push(patternsPath);

    const runs: Array<{img: string; psm: "6"|"7"|"13"}> = [
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

    const candidates: string[] = [];
    for (const r of runs) {
      console.log(`[OCR] ${ts()} 🧠 Tesseract PSM=${r.psm} on ${r.img}`);
      const { out, err } = await runTesseract(r.img, r.psm, patternsPath);
      if (err) console.log(`[OCR] ${ts()} ⚠️ Tesseract stderr: ${err.split("\n").slice(0,5).join(" ")}`);
      const snippet = out ? out.slice(0, 120).replace(/\s+/g, " ") : "<empty>";
      console.log(`[OCR] ${ts()} 🧾 Raw snippet: ${snippet}`);

      const extracted = extractActivationCode(out);
      console.log(`[OCR] ${ts()} 🔎 Extracted (${r.img}, PSM=${r.psm}): ${extracted || "<none>"}`);
      if (extracted) candidates.push(extracted);
    }

    // Deduplicate, score, pick best
    const uniq = Array.from(new Set(candidates));
    if (uniq.length === 0) {
      console.log(`[OCR] ${ts()} 🗳️ Candidates: <none>`);
      return res.json({ ok: true, rawText: "", code: "" });
    }
    const best = uniq
      .map(c => ({ c, score: scoreCandidate(c) }))
      .sort((a, b) => b.score - a.score)[0];

    console.log(`[OCR] ${ts()} 🗳️ Candidates: ${uniq.map(c => c.replace(/-/g,"")).join(" | ")}`);
    const cleaned = normalizeSerialBusiness(best.c);
    console.log(`[OCR] ${ts()} ✅ Final cleaned code: ${cleaned}`);

    return res.json({ ok: true, rawText: uniq.join("\n"), code: cleaned });
  } catch (err: any) {
    console.error(`[OCR] ${ts()} 💥 Error: ${err?.message || String(err)}`);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    // Cleanup temp files unless debugging
    const KEEP = process.env.KEEP_PREP_DEBUG === "1";
    if (!KEEP) {
      const unique = Array.from(new Set(toCleanup));
      await Promise.all(unique.map(p => fs.unlink(p).catch(() => {})));
    } else {
      console.log(`[OCR] ${ts()} 🧰 KEEP_PREP_DEBUG=1 — not deleting temp files`);
    }
  }
}