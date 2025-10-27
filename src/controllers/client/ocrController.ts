// src/controllers/client/ocrController.ts
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
function now() { return new Date().toISOString().slice(11, 19); }
function log(...args: any[]) { console.log("[OCR]", now(), ...args); }

/* ---------------- business helpers ---------------- */
function normalizeBusiness(s: string) {
  let out = s || "";
  out = out.replace(/O|o/g, "0");
  out = out.replace(/S|s/g, "5");
  out = out.replace(/1/g, "I");
  return out;
}
function wantFormat(s: string) {
  return /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(s);
}
function insertHyphens15(raw15: string) {
  return `${raw15.slice(0,5)}-${raw15.slice(5,10)}-${raw15.slice(10,15)}`;
}

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

async function runTesseractTSV(filePath: string, psm: PSM = "13"): Promise<string> {
  const args = [
    filePath, "tsv",
    "--oem", "1",
    "--psm", psm,
    "-l", "eng",
    "-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-",
    "-c", "tessedit_char_blacklist=abcdefghijklmnopqrstuvwxyz",
    "-c", "load_system_dawg=0",
    "-c", "load_freq_dawg=0",
    "--tessdata-dir", TESSDATA_DIR,
  ];
  const { stdout } = await execFileAsync("tesseract", args, {
    env: { ...process.env, OMP_THREAD_LIMIT: "2" },
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout || "";
}

/* ---------------- TSV disambiguation ---------------- */
type Sym = { ch: string; conf: number; x: number; y: number; w: number; h: number };

const AMBIG_PAIRS: Record<string, string> = {
  "6": "G", "G": "6",
  "2": "Z", "Z": "2",
  "0": "C", "C": "0",
  "8": "B", "B": "8",
  "7": "T", "T": "7",
  "D": "0"
};

function parseTSV(tsv: string): Sym[] {
  const rows = tsv.split(/\r?\n/);
  const out: Sym[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i].split("\t");
    if (cols.length < 12) continue;
    if (Number(cols[0]) !== 5) continue; // symbols
    const left = Number(cols[6]), top = Number(cols[7]), width = Number(cols[8]), height = Number(cols[9]);
    const conf = Number(cols[10]);
    const text = (cols[11] || "").toUpperCase();
    if (!/^[A-Z0-9-]$/.test(text)) continue;
    out.push({ ch: text, conf: isFinite(conf) ? conf : 0, x: left, y: top, w: width, h: height });
  }
  out.sort((a, b) => a.x - b.x);
  return out;
}

function best15FromTSVSymbols(syms: Sym[]): { raw15: string, avgConf: number } | null {
  const alnum = syms.filter(s => /^[A-Z0-9]$/.test(s.ch));
  if (alnum.length < 15) return null;
  let best: { raw15: string, avgConf: number } | null = null;
  for (let i = 0; i <= alnum.length - 15; i++) {
    const seg = alnum.slice(i, i + 15);
    const raw15 = seg.map(s => s.ch).join("");
    const avgConf = seg.reduce((a, s) => a + s.conf, 0) / 15;
    if (!best || avgConf > best.avgConf) best = { raw15, avgConf };
  }
  return best;
}

function disambiguateWithTSV(tsv: string): string | null {
  const syms = parseTSV(tsv);
  const best = best15FromTSVSymbols(syms);
  if (!best) return null;

  const alnum = syms.filter(s => /^[A-Z0-9]$/.test(s.ch));
  const base = best.raw15.split("");
  const confs = alnum.slice(0, 15).map(s => s.conf);

  type Node = { s: string, score: number };
  let beam: Node[] = [{ s: base.join(""), score: 0 }];
  const BEAM_WIDTH = 8;
  const FLIP_CONF_THRESHOLD = 85;

  for (let i = 0; i < 15; i++) {
    const next: Node[] = [];
    for (const node of beam) {
      const ch = node.s[i];
      const conf = confs[i] ?? 0;
      // keep
      next.push({ s: node.s, score: node.score + Math.log((conf + 1) / 101) });
      // flip (if ambiguous & low confidence)
      const alt = AMBIG_PAIRS[ch];
      if (alt && conf < FLIP_CONF_THRESHOLD) {
        const arr = node.s.split(""); arr[i] = alt;
        next.push({ s: arr.join(""), score: node.score + Math.log(((100 - conf) + 1) / 101) });
      }
    }
    next.sort((a, b) => b.score - a.score);
    beam = next.slice(0, BEAM_WIDTH);
  }

  for (const cand of beam) {
    const withHyph = insertHyphens15(cand.s);
    if (wantFormat(withHyph)) return withHyph;
  }
  return insertHyphens15(beam[0].s);
}

/* ---------------- sharp variants (TS-safe) ---------------- */
function base(img: sharp.Sharp): sharp.Sharp {
  return img
    .rotate()
    .grayscale()
    .extend({ top: 8, bottom: 8, left: 0, right: 0, background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .resize({ width: 1600, withoutEnlargement: false });
}

async function makeVariants(inputPath: string, baseOut: string): Promise<string[]> {
  const outs: string[] = [];

  // V1: moderate sharpen + linear + threshold(210)
  {
    const out = `${baseOut}.v1.png`;
    const buf = await base(sharp(inputPath))
      .sharpen(1)
      .linear(1.2, -10)
      .threshold(210)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf);
    outs.push(out); log("✅ Prepped V1:", out);
  }

  // V2: softer (no threshold)
  {
    const out = `${baseOut}.v2.png`;
    const buf = await base(sharp(inputPath))
      .sharpen(0.5)
      .linear(1.1, -5)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf);
    outs.push(out); log("✅ Prepped V2:", out);
  }

  // V3: lower threshold(190)
  {
    const out = `${baseOut}.v3.png`;
    const buf = await base(sharp(inputPath))
      .sharpen(0.8)
      .linear(1.15, -8)
      .threshold(190)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf);
    outs.push(out); log("✅ Prepped V3:", out);
  }

  // V4: stronger threshold(225)
  {
    const out = `${baseOut}.v4.png`;
    const buf = await base(sharp(inputPath))
      .sharpen(1.2)
      .linear(1.25, -12)
      .threshold(225)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf);
    outs.push(out); log("✅ Prepped V4:", out);
  }

  // V5: inverted (negative) + threshold(210)
  {
    const out = `${baseOut}.v5_neg.png`;
    const buf = await base(sharp(inputPath))
      .negate()
      .linear(1.2, -10)
      .threshold(210)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf);
    outs.push(out); log("✅ Prepped V5 (neg):", out);
  }

  // V6: horizontal "bold" via 3x3 ones kernel (fixes invalid-kernel error by using 3x3)
  {
    const out = `${baseOut}.v6_boldx.png`;
    const kernel: any = { width: 3, height: 3, kernel: [
      1, 1, 1,
      1, 1, 1,
      1, 1, 1
    ], scale: 1 };
    const buf = await base(sharp(inputPath))
      .linear(1.15, -8)
      .threshold(205)
      .convolve(kernel as any)   // makes thin strokes/hyphens a touch bolder
      .png()
      .toBuffer();
    await fs.writeFile(out, buf);
    outs.push(out); log("✅ Prepped V6 (bold-x):", out);
  }

  return outs;
}

/* ---------------- controller ---------------- */
export async function ocrTesseract(req: Request, res: Response) {
  let tmpPath = "";
  const toCleanup: string[] = [];
  try {
    if (!req.file?.buffer) {
      log("❌ No file uploaded.");
      return res.status(400).json({ ok: false, error: "No file uploaded (field must be 'img')." });
    }

    // 1) save upload (temporary)
    tmpPath = join(tmpdir(), `roi_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    await fs.writeFile(tmpPath, req.file.buffer);
    log("📸 Saved upload:", tmpPath, "bytes:", req.file.buffer.length);

    // 2) preprocess variants
    const baseOut = tmpPath.replace(/\.jpg$/i, ".prep");
    const variants = await makeVariants(tmpPath, baseOut);
    toCleanup.push(...variants);

    // 3) try each variant with PSM 13 → 7 → 6
    const psms: PSM[] = ["13", "7", "6"];
    let bestRaw = "";
    let bestCode = "";
    let chosenVariantPath = "";

    outer:
    for (const v of variants) {
      for (const p of psms) {
        const tag = v.split("/").pop() || v;
        const raw = await runTesseract(v, p, tag);
        const code = extractActivationCode(raw);
        log(`🔎 Extracted (${tag}, PSM=${p}):`, code || "<none>");
        if (code) {
          bestRaw = raw;
          bestCode = code;
          chosenVariantPath = v;
          break outer;
        }
      }
    }

    // 4) TSV refinement (only if we have a variant to analyze)
    if (chosenVariantPath) {
      try {
        log("🔬 Running TSV refinement on:", chosenVariantPath);
        const tsv = await runTesseractTSV(chosenVariantPath, "13");
        const tsvCode = disambiguateWithTSV(tsv);
        log("TSV candidate:", tsvCode || "<none>");
        if (tsvCode && wantFormat(tsvCode)) {
          bestCode = tsvCode;
        }
      } catch (e: any) {
        log("TSV refinement error:", e?.message || e);
      }
    }

    // 5) Business replacements at the end
    const cleaned = normalizeBusiness(bestCode);
    log("✅ Final cleaned code:", cleaned || "<none>");

    return res.json({
      ok: true,
      rawText: bestRaw,
      code: cleaned,
      debug: {
        triedVariants: variants.map(v => v.split("/").pop()),
        usedVariant: chosenVariantPath ? chosenVariantPath.split("/").pop() : null
      }
    });
  } catch (err: any) {
    log("💥 Error:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    // 6) cleanup: delete all temp files (original + variants)
    const unique = Array.from(new Set(toCleanup.concat(tmpPath ? [tmpPath] : [])));
    await Promise.all(unique.map(p => fs.unlink(p).catch(() => {})));
  }
}