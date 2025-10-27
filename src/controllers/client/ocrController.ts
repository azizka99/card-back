// src/controllers/client/ocrController.ts
import { Request, Response } from "express";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

// ✅ change if you symlinked tessdata_best → tessdata (then this can be omitted)
const TESSDATA_DIR = "/usr/share/tesseract-ocr/4.00/tessdata_best";

// ---- Helpers ----
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

  // tolerant 5-5-5 with optional inner spaces
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

// ---- Core: run tesseract on a temp file ----
async function runTesseractTemp(filePath: string, psm: "6" | "7" = "7"): Promise<string> {
  const args = [
    filePath, "stdout",
    "--oem", "1",
    "--psm", psm,
    "-l", "eng",
    "-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-",
    "--tessdata-dir", TESSDATA_DIR,
  ];
  const { stdout } = await execFileAsync("tesseract", args, {
    env: { ...process.env, OMP_THREAD_LIMIT: "2" }, // good for 2 vCPU (t4g.small)
    maxBuffer: 5 * 1024 * 1024,
  });
  return (stdout || "").trim();
}

// ---- Controller ----
export async function ocrTesseract(req: Request, res: Response) {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: "No file uploaded (field name must be 'img')." });
    }

    // write buffer to /tmp as an image file for tesseract
    const tmpPath = join(tmpdir(), `roi_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    await fs.writeFile(tmpPath, req.file.buffer);

    let raw = await runTesseractTemp(tmpPath, "7"); // single line
    let code = extractActivationCode(raw);
    if (!code) {
      // fallback: psm 6 (block) sometimes helps
      const raw2 = await runTesseractTemp(tmpPath, "6");
      raw += raw2 ? `\n\n[psm6]\n${raw2}` : "";
      code = extractActivationCode(raw2 || "");
    }

    // Apply your *post* normalization AFTER we have XXXXX-XXXXX-XXXXX
    const cleaned = normalizeSerialToBusinessRules(code);

    // cleanup
    await fs.unlink(tmpPath).catch(() => {});

    return res.json({
      ok: true,
      rawText: raw,
      code: cleaned,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}