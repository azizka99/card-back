import { Request, Response } from "express";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

// ✅ If you symlinked tessdata_best -> tessdata, you can remove --tessdata-dir usage below.
const TESSDATA_DIR = "/usr/share/tesseract-ocr/4.00/tessdata_best";

/* ---------------- Image Preprocessing (Sharp) ---------------- */
async function prepForOcr(inputPath: string, outPath: string) {
  // Make a high-contrast, crisp, consistent-size, BW line image (PNG)
  const buf = await sharp(inputPath)
    .grayscale()                   // remove color noise
    .sharpen(1)                    // crisper edges
    .linear(1.2, -10)              // slight contrast boost (gain, bias) — tweak if needed
    .resize({ width: 1600 })       // consistent OCR scale
    .threshold(210)                // binarize to pure black/white (adjust 200–225 for your images)
    .png()
    .toBuffer();

  await fs.writeFile(outPath, buf);
}

/* ---------------- Helpers ---------------- */
function normalizeSerialToBusinessRules(serial: string): string {
  if (!serial) return "";
  let s = serial;
  s = s.replace(/O|o/gi, "0"); // O/o -> 0
  s = s.replace(/S|s/gi, "5"); // S/s -> 5
  s = s.replace(/1/g, "I");    // 1   -> I
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

async function runTesseract(filePath: string, psm: "7" | "6" = "7"): Promise<string> {
  const args = [
    filePath, "stdout",
    "--oem", "1",
    "--psm", psm,
    "-l", "eng",
    "-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-",
    "--tessdata-dir", TESSDATA_DIR,
  ];
  const { stdout } = await execFileAsync("tesseract", args, {
    env: { ...process.env, OMP_THREAD_LIMIT: "2" }, // good for 2 vCPUs
    maxBuffer: 5 * 1024 * 1024,
  });
  return (stdout || "").trim();
}

/* ---------------- Controller ---------------- */
export async function ocrTesseract(req: Request, res: Response) {
  let tmpPath = "";
  let preppedPath = "";
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: "No file uploaded (field must be 'img')." });
    }

    // 1) Save upload to /tmp
    tmpPath = join(tmpdir(), `roi_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    await fs.writeFile(tmpPath, req.file.buffer);

    // 2) Preprocess with Sharp → /tmp/*.prep.png
    preppedPath = tmpPath.replace(/\.jpg$/i, ".prep.png");
    await prepForOcr(tmpPath, preppedPath);

    // 3) OCR (PSM 7 → fallback PSM 6)
    let raw = await runTesseract(preppedPath, "7");
    let code = extractActivationCode(raw);

    if (!code) {
      const raw6 = await runTesseract(preppedPath, "6");
      raw += raw6 ? `\n[psm6]\n${raw6}` : "";
      code = extractActivationCode(raw6 || "");
    }

    // 4) Business replacements AFTER we have XXXXX-XXXXX-XXXXX
    const cleaned = normalizeSerialToBusinessRules(code);

    return res.json({
      ok: true,
      rawText: raw,
      code: cleaned,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    // 5) cleanup
    if (preppedPath) await fs.unlink(preppedPath).catch(() => {});
    if (tmpPath) await fs.unlink(tmpPath).catch(() => {});
  }
}