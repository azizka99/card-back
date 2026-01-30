/**
 * activate_epay.js
 * Node 18+ (global fetch)
 *
 * Inputs:
 *  - barcodes.txt: one barcode per line (pan)
 *  - tids.txt: one terminalId per line
 *
 * Outputs (updated in realtime):
 *  - status.csv: per barcode summary
 *  - log.ndjson: full request/response/error log (one JSON per line)
 *
 * Run:
 *   node activate_epay.js
 */

const fs = require("fs");
const path = require("path");


// ===================== CONFIG =====================
const API_URL = "https://epay.arascominternaloffice.com/epay/activation";
const INTERNAL_TOKEN =
  "d5836dbc6446f28f27dc34084b83dad90c7ad9901b69b255b779cc6f0308780d";

const EAN = "4260433453118";
const AMOUNT = "20000";
const CURRENCY = "978";

const INPUT_BARCODES = path.join(__dirname, "ibo-qalanlar.txt");
const INPUT_TIDS = path.join(__dirname, "tids.txt");

const OUT_STATUS = path.join(__dirname, "status-ibo1.csv");
const OUT_LOG = path.join(__dirname, "log-ibo1.ndjson");

const TIMEZONE = "Europe/Berlin";
const END_HOUR = 15;
const END_MINUTE = 10;

const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2; // retries after the first attempt (total attempts = 1 + MAX_RETRIES)
const RETRY_BASE_DELAY_MS = 1500;
const JITTER_MS = 1200; // +/- jitter per scheduled send
// =================== END CONFIG ===================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function appendNdjson(obj) {
  fs.appendFileSync(OUT_LOG, JSON.stringify(obj) + "\n", "utf8");
}

function appendStatusRow(row) {
  fs.appendFileSync(OUT_STATUS, row + "\n", "utf8");
}

function ensureStatusHeader() {
  if (!fs.existsSync(OUT_STATUS)) {
    appendStatusRow(
      "barcode,status,txId,terminalId,serverDateTime,resultText,attempts,at"
    );
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Compute today 19:00 in Europe/Berlin as epoch ms (works without external libs)
function berlinEndTimeMsToday() {
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = dateFmt.formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  const y = get("year");
  const m = get("month");
  const d = get("day");

  // Determine Berlin offset at that date/time (CET/CEST)
  const offsetFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
  });

  const offsetParts = offsetFmt.formatToParts(
    new Date(`${y}-${m}-${d}T${String(END_HOUR).padStart(2, "0")}:${String(
      END_MINUTE
    ).padStart(2, "0")}:00Z`)
  );

  const off = offsetParts.find((p) => p.type === "timeZoneName")?.value || "UTC";
  const match = off.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  const hoursOff = match ? parseInt(match[1], 10) : 0;
  const minsOff = match && match[2] ? parseInt(match[2], 10) : 0;
  const totalOffMs = (hoursOff * 60 + Math.sign(hoursOff) * minsOff) * 60 * 1000;

  const utcMs =
    Date.parse(
      `${y}-${m}-${d}T${String(END_HOUR).padStart(2, "0")}:${String(
        END_MINUTE
      ).padStart(2, "0")}:00Z`
    ) - totalOffMs;

  return utcMs;
}

function summarizeResponse(json) {
  // Your response sample:
  // { ok, txId, response: { TERMINALID, SERVERDATETIME, RESULTTEXT, ... }, epayResultText ... }
  const terminalId =
    json?.response?.TERMINALID ??
    json?.response?.TERMINALID?.toString?.() ??
    "";
  const serverDateTime = json?.response?.SERVERDATETIME ?? "";
  const txId = json?.txId ?? json?.response?.TXID ?? "";
  const resultText =
    json?.epayResultText ??
    json?.response?.RESULTTEXT ??
    json?.response?.RESULT_TEXT ??
    "";

  const ok = json?.ok === true || json?.epayResult === 0 || json?.response?.RESULT === 0;

  return { ok, txId, terminalId, serverDateTime, resultText };
}

async function activateOne({ barcode, terminalId, index }) {
  const startedAt = new Date().toISOString();

  const payload = {
    ean: EAN,
    amount: AMOUNT,
    currency: CURRENCY,
    terminalId: String(terminalId),
    pan: String(barcode),
  };

  const reqHeaders = {
    "Content-Type": "application/json",
    "x-internal-token": INTERNAL_TOKEN,
  };

  // Log what we are about to send
  appendNdjson({
    type: "request",
    at: startedAt,
    index,
    barcode,
    terminalId: String(terminalId),
    url: API_URL,
    headers: { ...reqHeaders, "x-internal-token": "***" }, // mask token in logs
    body: payload,
  });

  let attempt = 0;
  let lastErr = null;

  while (attempt <= MAX_RETRIES) {
    const attemptAt = new Date().toISOString();
    try {
      const res = await fetchWithTimeout(
        API_URL,
        {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify(payload),
        },
        REQUEST_TIMEOUT_MS
      );

      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {
        // non-json response
      }

      const finishedAt = new Date().toISOString();

      appendNdjson({
        type: "response",
        at: finishedAt,
        index,
        barcode,
        terminalId: String(terminalId),
        attempt,
        httpStatus: res.status,
        httpOk: res.ok,
        raw: text.slice(0, 20000),
        json,
      });

      // Decide success
      if (json) {
        const s = summarizeResponse(json);
        const status = s.ok ? "activated" : "failed";
        appendStatusRow(
          [
            barcode,
            status,
            s.txId || "",
            s.terminalId || String(terminalId),
            s.serverDateTime || "",
            (s.resultText || "").replaceAll(",", " "), // keep CSV safe
            attempt + 1,
            finishedAt,
          ].join(",")
        );

        return { ok: s.ok, ...s, attempts: attempt + 1 };
      } else {
        // no json: treat non-2xx as fail
        const ok = res.ok;
        appendStatusRow(
          [
            barcode,
            ok ? "activated" : "failed",
            "",
            String(terminalId),
            "",
            (ok ? "ok_non_json" : "http_error_non_json").replaceAll(",", " "),
            attempt + 1,
            finishedAt,
          ].join(",")
        );

        return { ok, attempts: attempt + 1 };
      }
    } catch (err) {
      lastErr = String(err?.message || err);
      appendNdjson({
        type: "error",
        at: new Date().toISOString(),
        index,
        barcode,
        terminalId: String(terminalId),
        attempt,
        error: lastErr,
      });

      if (attempt === MAX_RETRIES) {
        const at = new Date().toISOString();
        appendStatusRow(
          [
            barcode,
            "failed",
            "",
            String(terminalId),
            "",
            `error:${lastErr}`.replaceAll(",", " "),
            attempt + 1,
            at,
          ].join(",")
        );
        return { ok: false, error: lastErr, attempts: attempt + 1 };
      }

      const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(backoff);
    } finally {
      attempt += 1;
    }
  }

  return { ok: false, error: lastErr, attempts: MAX_RETRIES + 1 };
}

(async () => {
  ensureStatusHeader();

  const barcodes = readLines(INPUT_BARCODES);
  const tids = readLines(INPUT_TIDS);

  if (barcodes.length === 0) {
    console.error("barcodes.txt is empty or missing.");
    process.exit(1);
  }
  if (tids.length === 0) {
    console.error("tids.txt is empty or missing.");
    process.exit(1);
  }

  const startMs = Date.now();
  const endMs = berlinEndTimeMsToday();

  if (endMs <= startMs) {
    console.error(`End time already passed today (${TIMEZONE} ${END_HOUR}:${END_MINUTE}).`);
    process.exit(1);
  }

  const totalMs = endMs - startMs;
  const n = barcodes.length;
  const stepMs = totalMs / n;

  console.log(`Barcodes: ${n}`);
  console.log(`TIDs: ${tids.length}`);
  console.log(`Now: ${new Date(startMs).toISOString()}`);
  console.log(`End: ${new Date(endMs).toISOString()}`);
  console.log(`Avg spacing: ${(stepMs / 1000).toFixed(2)} seconds`);

  appendNdjson({
    type: "run_start",
    at: new Date().toISOString(),
    n,
    tidsCount: tids.length,
    apiUrl: API_URL,
    endIso: new Date(endMs).toISOString(),
    avgSpacingSeconds: +(stepMs / 1000).toFixed(2),
  });

  for (let i = 0; i < n; i++) {
    const scheduled = startMs + i * stepMs;
    const jitter = Math.floor((Math.random() * 2 - 1) * JITTER_MS);
    const scheduledWithJitter = clamp(scheduled + jitter, startMs, endMs);

    const waitMs = scheduledWithJitter - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    const barcode = barcodes[i];
    const terminalId = pickRandom(tids);

    await activateOne({ barcode, terminalId, index: i });

    // tiny extra pause to avoid same-ms bursts
    await sleep(30);
  }

  appendNdjson({ type: "run_end", at: new Date().toISOString() });
  console.log("Done.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});