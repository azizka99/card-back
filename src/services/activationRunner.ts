import fs from "fs";
import path from "path";
import crypto from "crypto";
import { EventEmitter } from "events";
import prisma from "../constants/dbConnection";

// Server-side version of activate.js: sends every steam_card of a tag to epay,
// spread evenly until finish_at, persisting each result in activation_item.

// ===================== CONFIG =====================
const API_URL = process.env.EPAY_ACTIVATION_URL || "https://epay.arascominternaloffice.com/epay/activation";
const TIDS_FILE = process.env.EPAY_TIDS_FILE || path.join(process.cwd(), "tids.txt");
const CURRENCY = "978"; // EUR
const AMOUNT_UNITS_PER_EURO = 1000; // epay expects 20 EUR as "20000"
export const ALLOWED_AMOUNTS = [20, 30];

const REQUEST_TIMEOUT_MS = 20000;
const NETWORK_RETRIES = 2; // retries on the same TID after a network error
const RETRY_BASE_DELAY_MS = 1500;
const MAX_TID_SWITCHES = 5; // how many other TIDs to try after a limit error
const MIN_SPACING_MS = 1000;
const JITTER_RATIO = 0.3; // +/- 30% of the spacing
// =================== END CONFIG ===================

export type ItemStatus = "pending" | "sending" | "activated" | "already_active" | "failed" | "cancelled";
const DONE_STATUSES: ItemStatus[] = ["activated", "already_active"];

// "job" events carry a snapshot summary, "item" events a single changed row
export const activationEvents = new EventEmitter();
activationEvents.setMaxListeners(0);

// ---------- TIDs ----------

// tid -> Berlin day it hit its limit (limits reset daily)
const exhaustedTids = new Map<string, string>();

function berlinDay() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
}

function loadTids(): string[] {
    if (!fs.existsSync(TIDS_FILE)) return [];
    return fs.readFileSync(TIDS_FILE, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function pickTid(exclude: Set<string>): string | null {
    const today = berlinDay();
    const free = loadTids().filter((t) => !exclude.has(t) && exhaustedTids.get(t) !== today);
    if (free.length === 0) return null;
    return free[Math.floor(Math.random() * free.length)];
}

// ---------- epay ----------

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

type SendResult = { json: any; raw: string; httpStatus: number } | { error: string };

async function sendOnce(payload: Record<string, string>): Promise<SendResult> {
    const token = process.env.EPAY_INTERNAL_TOKEN;
    if (!token) return { error: "EPAY_INTERNAL_TOKEN is not set" };

    try {
        const res = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-internal-token": token },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const raw = await res.text();
        let json: any = null;
        try { json = JSON.parse(raw); } catch (_) { /* non-json */ }
        return { json, raw: raw.slice(0, 20000), httpStatus: res.status };
    } catch (err: any) {
        return { error: String(err?.message || err) };
    }
}

type Outcome = {
    kind: "activated" | "already_active" | "limit" | "failed";
    resultText: string;
    txId: string | null;
    remainingLimit: number | null;
};

// epay answers "limit error" when the terminal's daily limit is used up
function isLimitText(text: string) {
    return /limit/i.test(text);
}

function classify(r: { json: any; raw: string; httpStatus: number }, amountUnits: number): Outcome {
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
    if (ok) return { kind: "activated", resultText, txId, remainingLimit };
    if (/already in this state/i.test(resultText)) return { kind: "already_active", resultText, txId, remainingLimit };
    if (isLimitText(resultText) || (remainingLimit !== null && remainingLimit < amountUnits)) {
        return { kind: "limit", resultText: resultText || "terminal limit reached", txId, remainingLimit };
    }
    return { kind: "failed", resultText: resultText || `HTTP ${r.httpStatus}`, txId, remainingLimit };
}

// ---------- item ----------

async function activateItem(itemId: string, ean: string, amount: number) {
    // claim the item so a concurrent retry can't send it twice
    const claimed = await prisma.activation_item.updateMany({
        where: { id: itemId, status: "pending" },
        data: { status: "sending", ean, amount },
    });
    if (claimed.count === 0) return;

    let item = await prisma.activation_item.findUniqueOrThrow({ where: { id: itemId } });
    emitItem(item);

    const amountUnits = amount * AMOUNT_UNITS_PER_EURO;
    const triedTids = new Set<string>();
    let attempts = item.attempts;
    let status: ItemStatus = "failed";
    let resultText = "";
    let txId: string | null = null;
    let terminalId: string | null = null;
    let lastResponse: any = null;

    for (let switches = 0; switches <= MAX_TID_SWITCHES; switches++) {
        const tid = pickTid(triedTids);
        if (!tid) {
            resultText = triedTids.size ? `limit reached on ${triedTids.size} TIDs, no free TID left` : "no TID available (tids.txt empty?)";
            break;
        }
        triedTids.add(tid);
        terminalId = tid;

        const payload = { ean, amount: String(amountUnits), currency: CURRENCY, terminalId: tid, pan: item.barcode };

        let res: SendResult = { error: "not sent" };
        for (let n = 0; n <= NETWORK_RETRIES; n++) {
            attempts++;
            res = await sendOnce(payload);
            if (!("error" in res)) break;
            if (n < NETWORK_RETRIES) await sleep(RETRY_BASE_DELAY_MS * 2 ** n);
        }

        if ("error" in res) {
            resultText = `error: ${res.error}`;
            lastResponse = { error: res.error };
            break;
        }

        lastResponse = res.json ?? { raw: res.raw, httpStatus: res.httpStatus };
        const o = classify(res, amountUnits);
        resultText = o.resultText;
        txId = o.txId;

        if (o.kind === "limit") {
            exhaustedTids.set(tid, berlinDay());
            resultText = `limit on TID ${tid}: ${o.resultText}`;
            continue; // try another terminal
        }
        // terminal can't afford the next card anymore -> stop using it today
        if (o.remainingLimit !== null && o.remainingLimit < amountUnits) exhaustedTids.set(tid, berlinDay());

        status = o.kind;
        break;
    }

    item = await prisma.activation_item.update({
        where: { id: itemId },
        data: {
            status,
            attempts,
            terminal_id: terminalId,
            tx_id: txId,
            result_text: resultText,
            last_response: lastResponse,
        },
    });
    emitItem(item);
}

// ---------- job runner ----------

type RunnerCtl = { wake: () => void };
const runners = new Map<string, RunnerCtl>();

/** Resolves true when woken early (cancel / settings change / retry), false on timeout. */
function interruptibleSleep(ms: number, ctl: RunnerCtl) {
    return new Promise<boolean>((resolve) => {
        const t = setTimeout(() => done(false), ms);
        function done(woken: boolean) {
            clearTimeout(t);
            ctl.wake = () => {};
            resolve(woken);
        }
        ctl.wake = () => done(true);
    });
}

async function runJob(jobId: string) {
    if (runners.has(jobId)) return;
    const ctl: RunnerCtl = { wake: () => {} };
    runners.set(jobId, ctl);

    let lastSentAt = 0;
    let nextAt: number | null = null;
    try {
        while (true) {
            let job = await prisma.activation_job.findUnique({ where: { id: jobId } });
            if (!job || job.status !== "running") break;

            const pending = await prisma.activation_item.count({ where: { job_id: jobId, status: "pending" } });
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
                if (woken) nextAt = null; // job may have been cancelled or edited: recompute
                continue;
            }

            const next = await prisma.activation_item.findFirst({
                where: { job_id: jobId, status: "pending" },
                orderBy: { position: "asc" },
            });
            if (!next) continue;

            lastSentAt = Date.now();
            nextAt = null;
            await activateItem(next.id, job.ean, job.amount);
            await emitJob(jobId);
        }
    } catch (err) {
        console.error(`[activation] job ${jobId} crashed`, err);
    } finally {
        runners.delete(jobId);
    }
}

async function finishJob(jobId: string) {
    const job = await prisma.activation_job.update({
        where: { id: jobId },
        data: { status: "finished", ended_at: new Date() },
    });
    await prisma.tag.update({ where: { id: job.tag_id }, data: { is_activated: true } });
    await emitJob(jobId);
}

// ---------- public API ----------

export class ActivationError extends Error {
    constructor(public httpStatus: number, message: string) {
        super(message);
    }
}

export async function startJob(opts: { tagId: string; eanId: string; amount: number; finishAt: Date }) {
    if (!process.env.EPAY_INTERNAL_TOKEN) throw new ActivationError(500, "EPAY_INTERNAL_TOKEN is not configured on the server");
    if (!ALLOWED_AMOUNTS.includes(opts.amount)) throw new ActivationError(400, `Amount must be one of ${ALLOWED_AMOUNTS.join(", ")} EUR`);

    const ean = await prisma.ean.findUnique({ where: { id: opts.eanId } });
    if (!ean) throw new ActivationError(400, "Unknown EAN");

    const running = await prisma.activation_job.findFirst({ where: { tag_id: opts.tagId, status: "running" } });
    if (running) throw new ActivationError(409, "An activation is already running for this tag");

    // skip cards that an earlier job already activated
    const done = await prisma.activation_item.findMany({
        where: { status: { in: DONE_STATUSES }, job: { tag_id: opts.tagId } },
        select: { steam_card_id: true },
    });
    const doneIds = new Set(done.map((d) => d.steam_card_id));

    const cards = (await prisma.steam_card.findMany({
        where: { tag_id: opts.tagId },
        select: { id: true, barcode: true },
        orderBy: { created_at: "asc" },
    })).filter((c) => !doneIds.has(c.id));

    if (cards.length === 0) throw new ActivationError(400, "No cards left to activate for this tag");

    const jobId = crypto.randomUUID();
    await prisma.$transaction([
        prisma.activation_job.create({
            data: {
                id: jobId,
                tag_id: opts.tagId,
                ean: ean.code,
                amount: opts.amount,
                currency: CURRENCY,
                status: "running",
                finish_at: opts.finishAt,
                started_at: new Date(),
            },
        }),
        prisma.activation_item.createMany({
            data: cards.map((c, i) => ({
                id: crypto.randomUUID(),
                job_id: jobId,
                steam_card_id: c.id,
                position: i,
                barcode: c.barcode,
            })),
        }),
    ]);

    void runJob(jobId);
    return jobId;
}

export async function cancelJob(jobId: string) {
    const job = await prisma.activation_job.findUnique({ where: { id: jobId } });
    if (!job) throw new ActivationError(404, "Job not found");
    if (job.status !== "running") throw new ActivationError(409, `Job is already ${job.status}`);

    await prisma.$transaction([
        prisma.activation_job.update({ where: { id: jobId }, data: { status: "cancelled", ended_at: new Date() } }),
        prisma.activation_item.updateMany({ where: { job_id: jobId, status: "pending" }, data: { status: "cancelled" } }),
    ]);
    runners.get(jobId)?.wake();
    await emitJob(jobId, true);
}

/** Change EAN / amount for the cards that have not been sent yet. */
export async function updateJobSettings(jobId: string, opts: { eanId?: string; amount?: number; finishAt?: Date }) {
    const job = await prisma.activation_job.findUnique({ where: { id: jobId } });
    if (!job) throw new ActivationError(404, "Job not found");
    if (job.status !== "running") throw new ActivationError(409, "Only a running job can be changed");

    const data: { ean?: string; amount?: number; finish_at?: Date } = {};
    if (opts.eanId) {
        const ean = await prisma.ean.findUnique({ where: { id: opts.eanId } });
        if (!ean) throw new ActivationError(400, "Unknown EAN");
        data.ean = ean.code;
    }
    if (opts.amount !== undefined) {
        if (!ALLOWED_AMOUNTS.includes(opts.amount)) throw new ActivationError(400, `Amount must be one of ${ALLOWED_AMOUNTS.join(", ")} EUR`);
        data.amount = opts.amount;
    }
    if (opts.finishAt) data.finish_at = opts.finishAt;

    await prisma.activation_job.update({ where: { id: jobId }, data });
    runners.get(jobId)?.wake();
    await emitJob(jobId);
}

/** Put failed items back in the queue (optionally fixing the barcode first) and make sure the job runs. */
export async function retryItem(itemId: string, newBarcode?: string) {
    const item = await prisma.activation_item.findUnique({ where: { id: itemId } });
    if (!item) throw new ActivationError(404, "Item not found");
    if (!["failed", "pending"].includes(item.status)) throw new ActivationError(409, `Item is ${item.status}, cannot retry`);

    const barcode = newBarcode?.trim();
    if (barcode && barcode !== item.barcode) {
        if (!/^\d{16}$/.test(barcode)) throw new ActivationError(400, "Barcode must be 16 digits");
        try {
            await prisma.steam_card.update({ where: { id: item.steam_card_id }, data: { barcode } });
        } catch (err: any) {
            if (err?.code === "P2002") throw new ActivationError(409, "This barcode already belongs to another card");
            throw err;
        }
    }

    const updated = await prisma.activation_item.update({
        where: { id: itemId },
        data: { status: "pending", ...(barcode ? { barcode } : {}) },
    });
    emitItem(updated);
    await reopenJob(item.job_id);
}

export async function retryFailed(jobId: string) {
    const r = await prisma.activation_item.updateMany({ where: { job_id: jobId, status: "failed" }, data: { status: "pending" } });
    if (r.count === 0) throw new ActivationError(400, "No failed items to retry");
    await reopenJob(jobId);
    await emitJob(jobId, true);
}

async function reopenJob(jobId: string) {
    const job = await prisma.activation_job.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status !== "running") {
        const other = await prisma.activation_job.findFirst({ where: { tag_id: job.tag_id, status: "running", id: { not: jobId } } });
        if (other) throw new ActivationError(409, "Another activation is running for this tag; wait or cancel it first");
        await prisma.activation_job.update({ where: { id: jobId }, data: { status: "running", ended_at: null } });
    }
    if (runners.has(jobId)) runners.get(jobId)!.wake();
    else void runJob(jobId);
    await emitJob(jobId);
}

/** Called on server start: continue jobs that were running when the process stopped. */
export async function resumeActivationJobs() {
    // an item stuck in "sending" may or may not have reached epay; don't resend blindly
    await prisma.activation_item.updateMany({
        where: { status: "sending" },
        data: { status: "failed", result_text: "interrupted by server restart - check before retrying" },
    });
    const jobs = await prisma.activation_job.findMany({ where: { status: "running" }, select: { id: true } });
    for (const j of jobs) void runJob(j.id);
    if (jobs.length) console.log(`[activation] resumed ${jobs.length} job(s)`);
}

// ---------- snapshots / events ----------

export async function getJobSummary(jobId: string) {
    const job = await prisma.activation_job.findUnique({ where: { id: jobId } });
    if (!job) return null;

    const grouped = await prisma.activation_item.groupBy({
        by: ["status"],
        where: { job_id: jobId },
        _count: { _all: true },
    });
    const counts: Record<string, number> = { pending: 0, sending: 0, activated: 0, already_active: 0, failed: 0, cancelled: 0 };
    let total = 0;
    for (const g of grouped) {
        counts[g.status] = g._count._all;
        total += g._count._all;
    }
    return { job, counts, total };
}

/** Full state for the page: summary + every item (barcode/status) for the table and failed list. */
export async function getJobSnapshot(jobId: string) {
    const summary = await getJobSummary(jobId);
    if (!summary) return null;
    const items = await prisma.activation_item.findMany({
        where: { job_id: jobId },
        orderBy: { position: "asc" },
        select: { id: true, steam_card_id: true, barcode: true, status: true, result_text: true, terminal_id: true, attempts: true, ean: true, amount: true },
    });
    return { ...summary, items };
}

export async function getLatestJobId(tagId: string) {
    const job = await prisma.activation_job.findFirst({
        where: { tag_id: tagId },
        orderBy: { created_at: "desc" },
        select: { id: true },
    });
    return job?.id ?? null;
}

function emitItem(item: { id: string; job_id: string; steam_card_id: string; barcode: string; status: string; result_text: string | null; terminal_id: string | null; attempts: number; ean: string | null; amount: number | null }) {
    const { id, job_id, steam_card_id, barcode, status, result_text, terminal_id, attempts, ean, amount } = item;
    activationEvents.emit(`item:${job_id}`, { id, steam_card_id, barcode, status, result_text, terminal_id, attempts, ean, amount });
}

/** full=true tells clients to refetch the whole snapshot (bulk status changes). */
async function emitJob(jobId: string, full = false) {
    const summary = await getJobSummary(jobId);
    if (summary) activationEvents.emit(`job:${jobId}`, { ...summary, full });
}
