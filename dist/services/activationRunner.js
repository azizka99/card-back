"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActivationError = exports.activationEvents = exports.ALLOWED_AMOUNTS = void 0;
exports.startJob = startJob;
exports.cancelJob = cancelJob;
exports.pauseJob = pauseJob;
exports.resumeJob = resumeJob;
exports.updateJobSettings = updateJobSettings;
exports.retryItem = retryItem;
exports.retryFailed = retryFailed;
exports.resumeActivationJobs = resumeActivationJobs;
exports.getJobSummary = getJobSummary;
exports.getJobSnapshot = getJobSnapshot;
exports.getLatestJobId = getLatestJobId;
exports.getActivationOverview = getActivationOverview;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const events_1 = require("events");
const dbConnection_1 = __importDefault(require("../constants/dbConnection"));
// Server-side version of activate.js: sends every steam_card of a tag to epay,
// spread evenly until finish_at, persisting each result in activation_item.
// ===================== CONFIG =====================
const API_URL = process.env.EPAY_ACTIVATION_URL || "https://epay.arascominternaloffice.com/epay/activation";
const TIDS_FILE = process.env.EPAY_TIDS_FILE || path_1.default.join(process.cwd(), "tids.txt");
const CURRENCY = "978"; // EUR
const AMOUNT_UNITS_PER_EURO = 1000; // epay expects 20 EUR as "20000"
exports.ALLOWED_AMOUNTS = [20, 30];
const REQUEST_TIMEOUT_MS = 20000;
const NETWORK_RETRIES = 2; // retries on the same TID after a network error
const RETRY_BASE_DELAY_MS = 1500;
const MAX_TID_SWITCHES = 5; // how many other TIDs to try after a limit error
const MIN_SPACING_MS = 1000;
const JITTER_RATIO = 0.3; // +/- 30% of the spacing
const DONE_STATUSES = ["activated", "already_active"];
// "job" events carry a snapshot summary, "item" events a single changed row
exports.activationEvents = new events_1.EventEmitter();
exports.activationEvents.setMaxListeners(0);
// ---------- TIDs ----------
// tid -> Berlin day it hit its limit (limits reset daily)
const exhaustedTids = new Map();
function berlinDay() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
}
function loadTids() {
    if (!fs_1.default.existsSync(TIDS_FILE))
        return [];
    return fs_1.default.readFileSync(TIDS_FILE, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
function pickTid(exclude) {
    const today = berlinDay();
    const free = loadTids().filter((t) => !exclude.has(t) && exhaustedTids.get(t) !== today);
    if (free.length === 0)
        return null;
    return free[Math.floor(Math.random() * free.length)];
}
// ---------- epay ----------
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
// Retry a DB call through short outages (RDS unreachable, pool timeout, dropped connection).
// Used where losing the write would lose an epay result.
async function withDbRetry(label, fn, maxWaitMs = 10 * 60 * 1000) {
    const started = Date.now();
    for (let n = 0;; n++) {
        try {
            return await fn();
        }
        catch (err) {
            if (Date.now() - started > maxWaitMs)
                throw err;
            const delay = Math.min(30000, 2000 * 2 ** n);
            console.error(`[activation] ${label} failed (${err?.code || err?.message}), retrying in ${delay / 1000}s`);
            await sleep(delay);
        }
    }
}
async function sendOnce(payload) {
    const token = process.env.EPAY_INTERNAL_TOKEN;
    if (!token)
        return { error: "EPAY_INTERNAL_TOKEN is not set" };
    try {
        const res = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-internal-token": token },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const raw = await res.text();
        let json = null;
        try {
            json = JSON.parse(raw);
        }
        catch (_) { /* non-json */ }
        return { json, raw: raw.slice(0, 20000), httpStatus: res.status };
    }
    catch (err) {
        return { error: String(err?.message || err) };
    }
}
// epay answers "limit error" when the terminal's daily limit is used up
function isLimitText(text) {
    return /limit/i.test(text);
}
function classify(r, amountUnits) {
    const j = r.json;
    if (!j) {
        return { kind: "failed", resultText: `HTTP ${r.httpStatus} (non-JSON response)`, txId: null, remainingLimit: null };
    }
    const resultText = String(j.epayResultText ?? j.response?.RESULTTEXT ?? j.response?.RESULT_TEXT ?? j.error ?? "");
    const rawTxId = j.txId ?? j.response?.TXID;
    const txId = rawTxId === undefined || rawTxId === null ? null : String(rawTxId);
    const limitRaw = j.response?.LIMIT;
    const remainingLimit = limitRaw === undefined || limitRaw === null ? null : Number(limitRaw);
    const ok = j.ok === true || j.epayResult === 0 || j.response?.RESULT === 0;
    if (ok)
        return { kind: "activated", resultText, txId, remainingLimit };
    if (/already in this state/i.test(resultText))
        return { kind: "already_active", resultText, txId, remainingLimit };
    if (isLimitText(resultText) || (remainingLimit !== null && remainingLimit < amountUnits)) {
        return { kind: "limit", resultText: resultText || "terminal limit reached", txId, remainingLimit };
    }
    return { kind: "failed", resultText: resultText || `HTTP ${r.httpStatus}`, txId, remainingLimit };
}
function isInvalidAmount(o) {
    return o.status === "failed" && (/invalid amount/i.test(o.resultText) || o.lastResponse?.response?.RESULT === 9);
}
/** Send one card to epay, switching TID on limit errors. */
async function sendCard(barcode, ean, amount) {
    const amountUnits = amount * AMOUNT_UNITS_PER_EURO;
    const triedTids = new Set();
    const out = { status: "failed", attempts: 0, terminalId: null, txId: null, resultText: "", lastResponse: null };
    for (let switches = 0; switches <= MAX_TID_SWITCHES; switches++) {
        const tid = pickTid(triedTids);
        if (!tid) {
            out.resultText = triedTids.size ? `limit reached on ${triedTids.size} TIDs, no free TID left` : "no TID available (tids.txt empty?)";
            break;
        }
        triedTids.add(tid);
        out.terminalId = tid;
        const payload = { ean, amount: String(amountUnits), currency: CURRENCY, terminalId: tid, pan: barcode };
        let res = { error: "not sent" };
        for (let n = 0; n <= NETWORK_RETRIES; n++) {
            out.attempts++;
            res = await sendOnce(payload);
            if (!("error" in res))
                break;
            if (n < NETWORK_RETRIES)
                await sleep(RETRY_BASE_DELAY_MS * 2 ** n);
        }
        if ("error" in res) {
            out.resultText = `error: ${res.error}`;
            out.lastResponse = { error: res.error };
            break;
        }
        out.lastResponse = res.json ?? { raw: res.raw, httpStatus: res.httpStatus };
        const o = classify(res, amountUnits);
        out.resultText = o.resultText;
        out.txId = o.txId;
        if (o.kind === "limit") {
            exhaustedTids.set(tid, berlinDay());
            out.resultText = `limit on TID ${tid}: ${o.resultText}`;
            continue; // try another terminal
        }
        // terminal can't afford the next card anymore -> stop using it today
        if (o.remainingLimit !== null && o.remainingLimit < amountUnits)
            exhaustedTids.set(tid, berlinDay());
        out.status = o.kind;
        break;
    }
    return out;
}
/**
 * The item's own ean/amount (set by "retry with other EAN/amount") win over the job's.
 * On "invalid amount" the job's fallback EAN/amount is tried right away.
 */
async function activateItem(itemId, job) {
    const pendingItem = await dbConnection_1.default.activation_item.findUnique({ where: { id: itemId } });
    if (!pendingItem || pendingItem.status !== "pending")
        return;
    let ean = pendingItem.ean ?? job.ean;
    let amount = pendingItem.amount ?? job.amount;
    // claim the item so a concurrent retry can't send it twice
    const claimed = await dbConnection_1.default.activation_item.updateMany({
        where: { id: itemId, status: "pending" },
        data: { status: "sending", ean, amount },
    });
    if (claimed.count === 0)
        return;
    // no DB read between claiming and sending: a DB outage here used to strand cards in "sending"
    let item = { ...pendingItem, status: "sending", ean, amount };
    emitItem(item);
    let result = await sendCard(item.barcode, ean, amount);
    let attempts = item.attempts + result.attempts;
    const fb = job.fallback_ean && job.fallback_amount ? { ean: job.fallback_ean, amount: job.fallback_amount } : null;
    if (fb && isInvalidAmount(result) && (fb.ean !== ean || fb.amount !== amount)) {
        const first = `${ean} / ${amount} €`;
        ean = fb.ean;
        amount = fb.amount;
        result = await sendCard(item.barcode, ean, amount);
        attempts += result.attempts;
        result.resultText = `${result.resultText} (fallback after invalid amount on ${first})`;
    }
    item = await withDbRetry(`save item ${itemId}`, () => dbConnection_1.default.activation_item.update({
        where: { id: itemId },
        data: {
            status: result.status,
            attempts,
            ean,
            amount,
            terminal_id: result.terminalId,
            tx_id: result.txId,
            result_text: result.resultText,
            last_response: result.lastResponse,
        },
    }));
    emitItem(item);
}
const runners = new Map();
/** Tell a job's runner that the job changed (cancel / pause / settings / retry). */
function pokeRunner(jobId) {
    const ctl = runners.get(jobId);
    if (!ctl)
        return;
    ctl.dirty = true;
    ctl.wake();
}
/** Resolves true when woken early (cancel / settings change / retry), false on timeout. */
function interruptibleSleep(ms, ctl) {
    return new Promise((resolve) => {
        if (ctl.dirty)
            return resolve(true);
        const t = setTimeout(() => done(false), ms);
        function done(woken) {
            clearTimeout(t);
            ctl.wake = () => { };
            resolve(woken);
        }
        ctl.wake = () => done(true);
    });
}
async function runJob(jobId) {
    if (runners.has(jobId))
        return;
    const ctl = { wake: () => { }, dirty: false };
    runners.set(jobId, ctl);
    let lastSentAt = 0;
    let nextAt = null;
    let errors = 0;
    try {
        while (true) {
            try {
                ctl.dirty = false; // reading the job now picks up every change made so far
                let job = await dbConnection_1.default.activation_job.findUnique({ where: { id: jobId } });
                if (!job || job.status !== "running")
                    break;
                const pending = await dbConnection_1.default.activation_item.count({ where: { job_id: jobId, status: "pending" } });
                if (pending === 0) {
                    await finishJob(jobId);
                    break;
                }
                if (lastSentAt && nextAt === null) {
                    const msLeft = job.finish_at.getTime() - Date.now();
                    const spacing = Math.max(MIN_SPACING_MS, msLeft / pending);
                    const jitter = spacing * JITTER_RATIO * (Math.random() * 2 - 1);
                    nextAt = lastSentAt + spacing + jitter;
                }
                if (nextAt !== null && nextAt > Date.now()) {
                    const woken = await interruptibleSleep(nextAt - Date.now(), ctl);
                    if (woken)
                        nextAt = null; // job may have been cancelled or edited: recompute
                    continue;
                }
                const next = await dbConnection_1.default.activation_item.findFirst({
                    where: { job_id: jobId, status: "pending" },
                    orderBy: { position: "asc" },
                });
                if (!next)
                    continue;
                lastSentAt = Date.now();
                nextAt = null;
                await activateItem(next.id, job);
                await emitJob(jobId);
                errors = 0;
            }
            catch (err) {
                // e.g. RDS briefly unreachable (P1001): keep the job alive and try again
                errors++;
                const delay = Math.min(60000, 5000 * 2 ** (errors - 1));
                console.error(`[activation] job ${jobId} error #${errors} (${err?.code || err?.message}), retrying in ${delay / 1000}s`);
                await interruptibleSleep(delay, ctl);
            }
        }
    }
    finally {
        runners.delete(jobId);
    }
}
async function finishJob(jobId) {
    // this job's runner is sequential, so a card still "sending" here lost its result (DB down while saving)
    await dbConnection_1.default.activation_item.updateMany({
        where: { job_id: jobId, status: "sending" },
        data: { status: "failed", result_text: "result not saved (database error) - check before retrying" },
    });
    const job = await dbConnection_1.default.activation_job.update({
        where: { id: jobId },
        data: { status: "finished", ended_at: new Date() },
    });
    await dbConnection_1.default.tag.update({ where: { id: job.tag_id }, data: { is_activated: true } });
    await emitJob(jobId);
}
// ---------- public API ----------
class ActivationError extends Error {
    constructor(httpStatus, message) {
        super(message);
        this.httpStatus = httpStatus;
    }
}
exports.ActivationError = ActivationError;
async function eanCode(eanId) {
    const ean = await dbConnection_1.default.ean.findUnique({ where: { id: eanId } });
    if (!ean)
        throw new ActivationError(400, "Unknown EAN");
    return ean.code;
}
function checkAmount(amount) {
    if (!exports.ALLOWED_AMOUNTS.includes(amount))
        throw new ActivationError(400, `Amount must be one of ${exports.ALLOWED_AMOUNTS.join(", ")} EUR`);
}
/** EAN + amount given together, or neither (null = no override / no fallback). */
async function optionalEanAmount(eanId, amount) {
    if (!eanId && (amount === undefined || amount === null))
        return null;
    if (!eanId || amount === undefined || amount === null)
        throw new ActivationError(400, "Choose both EAN and amount");
    checkAmount(amount);
    return { ean: await eanCode(eanId), amount };
}
async function startJob(opts) {
    if (!process.env.EPAY_INTERNAL_TOKEN)
        throw new ActivationError(500, "EPAY_INTERNAL_TOKEN is not configured on the server");
    checkAmount(opts.amount);
    const ean = { code: await eanCode(opts.eanId) };
    const fallback = await optionalEanAmount(opts.fallbackEanId, opts.fallbackAmount);
    const running = await dbConnection_1.default.activation_job.findFirst({ where: { tag_id: opts.tagId, status: { in: ["running", "paused"] } } });
    if (running)
        throw new ActivationError(409, `An activation is already ${running.status} for this tag`);
    // skip cards that an earlier job already activated
    const done = await dbConnection_1.default.activation_item.findMany({
        where: { status: { in: DONE_STATUSES }, job: { tag_id: opts.tagId } },
        select: { steam_card_id: true },
    });
    const doneIds = new Set(done.map((d) => d.steam_card_id));
    const cards = (await dbConnection_1.default.steam_card.findMany({
        where: { tag_id: opts.tagId },
        select: { id: true, barcode: true },
        orderBy: { created_at: "asc" },
    })).filter((c) => !doneIds.has(c.id));
    if (cards.length === 0)
        throw new ActivationError(400, "No cards left to activate for this tag");
    const jobId = crypto_1.default.randomUUID();
    await dbConnection_1.default.$transaction([
        dbConnection_1.default.activation_job.create({
            data: {
                id: jobId,
                tag_id: opts.tagId,
                ean: ean.code,
                amount: opts.amount,
                currency: CURRENCY,
                fallback_ean: fallback?.ean ?? null,
                fallback_amount: fallback?.amount ?? null,
                status: "running",
                finish_at: opts.finishAt,
                started_at: new Date(),
            },
        }),
        dbConnection_1.default.activation_item.createMany({
            data: cards.map((c, i) => ({
                id: crypto_1.default.randomUUID(),
                job_id: jobId,
                steam_card_id: c.id,
                position: i,
                barcode: c.barcode,
            })),
        }),
        // hide the tag from the client as soon as its cards start being activated
        dbConnection_1.default.tag.update({ where: { id: opts.tagId }, data: { is_visible_to_user: false } }),
    ]);
    void runJob(jobId);
    return jobId;
}
async function cancelJob(jobId) {
    const job = await dbConnection_1.default.activation_job.findUnique({ where: { id: jobId } });
    if (!job)
        throw new ActivationError(404, "Job not found");
    if (job.status !== "running" && job.status !== "paused")
        throw new ActivationError(409, `Job is already ${job.status}`);
    await dbConnection_1.default.$transaction([
        dbConnection_1.default.activation_job.update({ where: { id: jobId }, data: { status: "cancelled", ended_at: new Date() } }),
        dbConnection_1.default.activation_item.updateMany({ where: { job_id: jobId, status: "pending" }, data: { status: "cancelled" } }),
    ]);
    pokeRunner(jobId);
    await emitJob(jobId, true);
}
/** Stop sending without giving up the remaining cards; resumeJob continues later. */
async function pauseJob(jobId) {
    const r = await dbConnection_1.default.activation_job.updateMany({ where: { id: jobId, status: "running" }, data: { status: "paused" } });
    if (r.count === 0)
        throw new ActivationError(409, "Only a running job can be paused");
    pokeRunner(jobId);
    await emitJob(jobId);
}
async function resumeJob(jobId, finishAt) {
    if (finishAt.getTime() <= Date.now())
        throw new ActivationError(400, "Finish time must be in the future");
    const r = await dbConnection_1.default.activation_job.updateMany({ where: { id: jobId, status: "paused" }, data: { status: "running", finish_at: finishAt } });
    if (r.count === 0)
        throw new ActivationError(409, "Only a paused job can be resumed");
    void runJob(jobId);
    await emitJob(jobId);
}
/** Change EAN / amount for the cards that have not been sent yet. */
/**
 * Change EAN / amount / finish time / fallback for cards not sent yet.
 * fallback: undefined = leave as is, null = remove, {eanId, amount} = set.
 */
async function updateJobSettings(jobId, opts) {
    const job = await dbConnection_1.default.activation_job.findUnique({ where: { id: jobId } });
    if (!job)
        throw new ActivationError(404, "Job not found");
    if (job.status !== "running" && job.status !== "paused")
        throw new ActivationError(409, "Only a running or paused job can be changed");
    const data = {};
    if (opts.eanId)
        data.ean = await eanCode(opts.eanId);
    if (opts.amount !== undefined) {
        checkAmount(opts.amount);
        data.amount = opts.amount;
    }
    if (opts.finishAt)
        data.finish_at = opts.finishAt;
    if (opts.fallback !== undefined) {
        const fb = opts.fallback && await optionalEanAmount(opts.fallback.eanId, opts.fallback.amount);
        data.fallback_ean = fb ? fb.ean : null;
        data.fallback_amount = fb ? fb.amount : null;
    }
    await dbConnection_1.default.activation_job.update({ where: { id: jobId }, data });
    pokeRunner(jobId);
    await emitJob(jobId);
}
/** Put failed items back in the queue (optionally fixing the barcode first) and make sure the job runs. */
/**
 * Put a failed card back in the queue, optionally with a corrected barcode and/or
 * another EAN + amount for this card only (otherwise the job's EAN/amount is used).
 */
async function retryItem(itemId, opts = {}) {
    const item = await dbConnection_1.default.activation_item.findUnique({ where: { id: itemId } });
    if (!item)
        throw new ActivationError(404, "Item not found");
    if (!["failed", "pending"].includes(item.status))
        throw new ActivationError(409, `Item is ${item.status}, cannot retry`);
    const override = await optionalEanAmount(opts.eanId, opts.amount);
    const newBarcode = opts.barcode;
    const barcode = newBarcode?.trim();
    if (barcode && barcode !== item.barcode) {
        if (!/^\d{16}$/.test(barcode))
            throw new ActivationError(400, "Barcode must be 16 digits");
        try {
            await dbConnection_1.default.steam_card.update({ where: { id: item.steam_card_id }, data: { barcode } });
        }
        catch (err) {
            if (err?.code === "P2002")
                throw new ActivationError(409, "This barcode already belongs to another card");
            throw err;
        }
    }
    const updated = await dbConnection_1.default.activation_item.update({
        where: { id: itemId },
        data: {
            status: "pending",
            ean: override?.ean ?? null,
            amount: override?.amount ?? null,
            ...(barcode ? { barcode } : {}),
        },
    });
    emitItem(updated);
    await reopenJob(item.job_id);
}
/** Retry all failed cards of a job, optionally all with another EAN + amount. */
async function retryFailed(jobId, opts = {}) {
    const override = await optionalEanAmount(opts.eanId, opts.amount);
    const r = await dbConnection_1.default.activation_item.updateMany({
        where: { job_id: jobId, status: "failed" },
        data: { status: "pending", ean: override?.ean ?? null, amount: override?.amount ?? null },
    });
    if (r.count === 0)
        throw new ActivationError(400, "No failed items to retry");
    await reopenJob(jobId);
    await emitJob(jobId, true);
}
async function reopenJob(jobId) {
    const job = await dbConnection_1.default.activation_job.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status === "paused") {
        await emitJob(jobId); // retried items wait until the job is resumed
        return;
    }
    if (job.status !== "running") {
        const other = await dbConnection_1.default.activation_job.findFirst({ where: { tag_id: job.tag_id, status: { in: ["running", "paused"] }, id: { not: jobId } } });
        if (other)
            throw new ActivationError(409, "Another activation is running for this tag; wait or cancel it first");
        await dbConnection_1.default.activation_job.update({ where: { id: jobId }, data: { status: "running", ended_at: null } });
    }
    if (runners.has(jobId))
        pokeRunner(jobId);
    else
        void runJob(jobId);
    await emitJob(jobId);
}
/** Called on server start: continue jobs that were running when the process stopped. */
async function resumeActivationJobs() {
    // safety net, also covers a DB outage at boot: every "running" job without a runner gets one
    setInterval(() => {
        restartOrphanedJobs().catch(() => { });
    }, 60000).unref();
    // an item stuck in "sending" may or may not have reached epay; don't resend blindly
    await dbConnection_1.default.activation_item.updateMany({
        where: { status: "sending" },
        data: { status: "failed", result_text: "interrupted by server restart - check before retrying" },
    });
    const n = await restartOrphanedJobs();
    if (n)
        console.log(`[activation] resumed ${n} job(s)`);
}
async function restartOrphanedJobs() {
    const running = await dbConnection_1.default.activation_job.findMany({ where: { status: "running" }, select: { id: true } });
    let n = 0;
    for (const j of running) {
        if (!runners.has(j.id)) {
            void runJob(j.id);
            n++;
        }
    }
    return n;
}
// ---------- snapshots / events ----------
async function getJobSummary(jobId) {
    const job = await dbConnection_1.default.activation_job.findUnique({ where: { id: jobId } });
    if (!job)
        return null;
    const grouped = await dbConnection_1.default.activation_item.groupBy({
        by: ["status"],
        where: { job_id: jobId },
        _count: { _all: true },
    });
    const counts = { pending: 0, sending: 0, activated: 0, already_active: 0, failed: 0, cancelled: 0 };
    let total = 0;
    for (const g of grouped) {
        counts[g.status] = g._count._all;
        total += g._count._all;
    }
    return { job, counts, total };
}
/** Full state for the page: summary + every item (barcode/status) for the table and failed list. */
async function getJobSnapshot(jobId) {
    const summary = await getJobSummary(jobId);
    if (!summary)
        return null;
    const items = await dbConnection_1.default.activation_item.findMany({
        where: { job_id: jobId },
        orderBy: { position: "asc" },
        select: { id: true, steam_card_id: true, barcode: true, status: true, result_text: true, terminal_id: true, attempts: true, ean: true, amount: true },
    });
    return { ...summary, items };
}
async function getLatestJobId(tagId) {
    const job = await dbConnection_1.default.activation_job.findFirst({
        where: { tag_id: tagId },
        orderBy: { created_at: "desc" },
        select: { id: true },
    });
    return job?.id ?? null;
}
function emitItem(item) {
    const { id, job_id, steam_card_id, barcode, status, result_text, terminal_id, attempts, ean, amount } = item;
    exports.activationEvents.emit(`item:${job_id}`, { id, steam_card_id, barcode, status, result_text, terminal_id, attempts, ean, amount });
}
/** full=true tells clients to refetch the whole snapshot (bulk status changes). */
async function emitJob(jobId, full = false) {
    const summary = await getJobSummary(jobId);
    if (summary)
        exports.activationEvents.emit(`job:${jobId}`, { ...summary, full });
}
// ---------- dashboard overview ----------
function berlinMidnight() {
    // e.g. "GMT+02:00" -> today 00:00 Berlin as UTC
    const off = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", timeZoneName: "longOffset" })
        .formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value || "GMT";
    const m = off.match(/GMT([+-])(\d{2}):(\d{2})/);
    const offsetMs = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000 : 0;
    return new Date(Date.parse(`${berlinDay()}T00:00:00Z`) - offsetMs);
}
/** Totals + the most recent jobs with their per-status counts, for the admin dashboard. */
async function getActivationOverview(limit = 30) {
    const jobs = await dbConnection_1.default.activation_job.findMany({
        orderBy: { created_at: "desc" },
        take: limit,
        include: { tag: { select: { name: true } } },
    });
    const jobIds = jobs.map((j) => j.id);
    const [perJob, today, allTime, openJobs] = await Promise.all([
        jobIds.length
            ? dbConnection_1.default.activation_item.groupBy({ by: ["job_id", "status"], where: { job_id: { in: jobIds } }, _count: { _all: true } })
            : Promise.resolve([]),
        dbConnection_1.default.activation_item.groupBy({
            by: ["status"],
            where: { status: { in: ["activated", "failed"] }, updated_at: { gte: berlinMidnight() } },
            _count: { _all: true },
        }),
        dbConnection_1.default.activation_item.count({ where: { status: "activated" } }),
        dbConnection_1.default.activation_job.findMany({ where: { status: { in: ["running", "paused"] } }, select: { id: true, status: true } }),
    ]);
    const openIds = openJobs.map((j) => j.id);
    const pendingOpen = openIds.length
        ? await dbConnection_1.default.activation_item.count({ where: { job_id: { in: openIds }, status: { in: ["pending", "sending"] } } })
        : 0;
    const todayCount = (status) => today.find((r) => r.status === status)?._count._all ?? 0;
    return {
        totals: {
            runningJobs: openJobs.filter((j) => j.status === "running").length,
            pausedJobs: openJobs.filter((j) => j.status === "paused").length,
            pendingCards: pendingOpen,
            today: { activated: todayCount("activated"), failed: todayCount("failed") },
            allTime: { activated: allTime },
        },
        jobs: jobs.map((j) => {
            const counts = { pending: 0, sending: 0, activated: 0, already_active: 0, failed: 0, cancelled: 0 };
            let total = 0;
            for (const r of perJob) {
                if (r.job_id !== j.id)
                    continue;
                counts[r.status] = r._count._all;
                total += r._count._all;
            }
            return {
                id: j.id,
                tagId: j.tag_id,
                tagName: j.tag.name,
                status: j.status,
                ean: j.ean,
                amount: j.amount,
                created_at: j.created_at,
                finish_at: j.finish_at,
                ended_at: j.ended_at,
                counts,
                total,
            };
        }),
    };
}
