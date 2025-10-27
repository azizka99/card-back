import { Request, Response } from "express";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const TESSDATA_DIR = "/usr/share/tesseract-ocr/4.00/tessdata_best";

/* ---------------- Small helpers ---------------- */
function now() { return new Date().toISOString().slice(11,19); }
function log(...args: any[]) { console.log("[OCR]", now(), ...args); }

function normalizeSerialToBusinessRules(serial: string): string {
  if (!serial) return "";
  let s = serial;
  s = s.replace(/O|o/gi, "0");
  s = s.replace(/S|s/gi, "5");
  s = s.replace(/1/g, "I");
  return s;
}

function extractActivationCode(rawText: string): string {
  if (!rawText) return "";
  const up = String(rawText).toUpperCase().replace(/\r?\n/g, " ");

  // tolerant 5-5-5 with optional inner spaces around hyphens and inside blocks
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
  return `${compact.slice(0,5)}-${compact.slice(5,10)}-${compact.slice(10,15)}`;
}

/* ---------------- Tesseract runner ---------------- */
async function runTesseract(filePath: string, psm: "13" | "7" | "6", tag: string): Promise<string> {
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

/* ---------------- Preprocess variants (Sharp) ----------------
   We’ll generate up to 4 PNG variants and try each with PSM 13 → 7 → 6
---------------------------------------------------------------- */
async function makeVariants(inputPath: string, baseOut: string): Promise<string[]> {
  const outs: string[] = [];

  // Common base: grayscale, +8px vertical padding, resize width 1600
  async function base(img: sharp.Sharp) {
    return img
      .rotate() // respect EXIF, just in case
      .grayscale()
      .extend({ top: 8, bottom: 8, left: 0, right: 0, background: { r:255, g:255, b:255, alpha:1 } })
      .resize({ width: 1600, withoutEnlargement: false });
  }

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
    outs.push(out);
    log("✅ Prepped V1:", out);
  }

  // V2: softer (no threshold) — helps when threshold wipes hyphens
  {
    const out = `${baseOut}.v2.png`;
    const buf = await base(sharp(inputPath))
      .sharpen(0.5)
      .linear(1.1, -5)
      .normalize() // auto contrast
      .png()
      .toBuffer();
    await fs.writeFile(out, buf);
    outs.push(out);
    log("✅ Prepped V2:", out);
  }

  // V3: lower threshold (190) + tiny median denoise
  {
    const out = `${baseOut}.v3.png`;
    const buf = await base(sharp(inputPath))
      .median(1)
      .linear(1.15, -8)
      .threshold(190)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf);
    outs.push(out);
    log("✅ Prepped V3:", out);
  }

  // V4: stronger threshold (225) + stronger sharpen
  {
    const out = `${baseOut}.v4.png`;
    const buf = await base(sharp(inputPath))
      .sharpen(1.2)
      .linear(1.25, -12)
      .threshold(225)
      .png()
      .toBuffer();
    await fs.writeFile(out, buf);
    outs.push(out);
    log("✅ Prepped V4:", out);
  }

  return outs;
}

/* ---------------- Controller ---------------- */
export async function ocrTesseract(req: Request, res: Response) {
  let tmpPath = "";
  const toCleanup: string[] = [];
  try {
    if (!req.file?.buffer) {
      log("❌ No file uploaded.");
      return res.status(400).json({ ok: false, error: "No file uploaded (field must be 'img')." });
    }

    // 1) Save upload to /tmp
    tmpPath = join(tmpdir(), `roi_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    await fs.writeFile(tmpPath, req.file.buffer);
    log("📸 Saved upload:", tmpPath, "bytes:", req.file.buffer.length);

    // 2) Create multiple preprocessed variants
    const baseOut = tmpPath.replace(/\.jpg$/i, ".prep");
    const variants = await makeVariants(tmpPath, baseOut);
    toCleanup.push(...variants);

    // 3) For each variant, try PSM 13 → 7 → 6
    const psms: Array<"13"|"7"|"6"> = ["13", "7", "6"];
    let bestRaw = "";
    let bestCode = "";

    outer:
    for (const v of variants) {
      for (const p of psms) {
        const raw = await runTesseract(v, p, v.split(".").slice(-2).join(".")); // tag like "v1.png"
        const code = extractActivationCode(raw);
        log(`🔎 Extracted (${v.split(".").slice(-2).join(".")}, PSM=${p}):`, code || "<none>");
        if (code) {
          bestRaw = raw;
          bestCode = code;
          break outer;
        }
      }
    }

    // 4) Business replacements AFTER we have XXXXX-XXXXX-XXXXX
    const cleaned = normalizeSerialToBusinessRules(bestCode);
    log("✅ Final cleaned code:", cleaned || "<none>");

    return res.json({
      ok: true,
      rawText: bestRaw,
      code: cleaned,
      debug: { triedVariants: variants.map(v => v.split(".").slice(-2).join(".")) }
    });
  } catch (err: any) {
    log("💥 Error:", err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    // 5) cleanup everything
    const unique = Array.from(new Set(toCleanup.concat(tmpPath ? [tmpPath] : [])));
    await Promise.all(unique.map(p => fs.unlink(p).catch(() => {})));
  }
}