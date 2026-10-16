import prisma from "../constants/dbConnection";

// Weekly activation report (Mon 00:00 - next Mon 00:00, Europe/Berlin) for checking the Monday invoice.
// A card counts in the week its final result was saved (activation_item.updated_at).

const DONE = ["activated", "already_active", "failed"];

/** "2026-W41" -> Monday of that ISO week as "YYYY-MM-DD" */
function isoWeekMonday(week: string): string | null {
    const m = /^(\d{4})-W(\d{2})$/.exec(week);
    if (!m) return null;
    const year = Number(m[1]);
    const w = Number(m[2]);
    if (w < 1 || w > 53) return null;
    const jan4 = new Date(Date.UTC(year, 0, 4)); // always in week 1
    const week1Monday = Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7));
    return new Date(week1Monday + (w - 1) * 7 * 86400000).toISOString().slice(0, 10);
}

function isoWeekOf(dateStr: string): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    const day = (d.getUTCDay() + 6) % 7; // Mon=0
    d.setUTCDate(d.getUTCDate() - day + 3); // Thursday decides the year
    const year = d.getUTCFullYear();
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return `${year}-W${String(week).padStart(2, "0")}`;
}

function addDays(dateStr: string, days: number) {
    return new Date(Date.parse(`${dateStr}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function berlinToday() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
}

export { isoWeekOf, isoWeekMonday };

/** Default: last week. */
export function defaultReportWeek() {
    return isoWeekOf(addDays(berlinToday(), -7));
}

// "limit on TID 47857336: limit error" -> "limit on TID …: limit error", so reasons group together
function normalizeReason(text: string | null) {
    return (text || "unknown").replace(/TID \d+/g, "TID …").replace(/\d{6,}/g, "…").trim();
}

export async function getWeeklyReport(week: string) {
    const monday = isoWeekMonday(week);
    if (!monday) return null;
    const nextMonday = addDays(monday, 7);
    const prevMonday = addDays(monday, -7);

    // bounds as Berlin wall-clock times; Postgres converts them to UTC (handles summer/winter time)
    const range = (from: string, to: string) => prisma.$queryRaw<{ s: Date; e: Date }[]>`
        SELECT (${from}::timestamp AT TIME ZONE 'Europe/Berlin') AS s, (${to}::timestamp AT TIME ZONE 'Europe/Berlin') AS e`;
    const [{ s, e }] = await range(monday, nextMonday);
    const [{ s: ps, e: pe }] = await range(prevMonday, monday);

    const [perJob, perDay, reasons, terminals, prevWeek] = await Promise.all([
        // a card may have been sent with its own EAN (retry with other EAN, fallback), so take the card's
        prisma.$queryRaw<{ job_id: string; status: string; ean: string; n: number; first_at: Date; last_at: Date }[]>`
            SELECT i.job_id, i.status, coalesce(i.ean, j.ean) AS ean, count(*)::int AS n,
                   min(i.updated_at) AS first_at, max(i.updated_at) AS last_at
            FROM activation_item i JOIN activation_job j ON j.id = i.job_id
            WHERE i.status IN ('activated', 'already_active', 'failed') AND i.updated_at >= ${s} AND i.updated_at < ${e}
            GROUP BY 1, 2, 3`,
        prisma.$queryRaw<{ d: string; status: string; n: number }[]>`
            SELECT to_char(updated_at AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') AS d, status, count(*)::int AS n
            FROM activation_item
            WHERE status IN ('activated', 'already_active', 'failed') AND updated_at >= ${s} AND updated_at < ${e}
            GROUP BY 1, 2`,
        prisma.$queryRaw<{ r: string | null; n: number }[]>`
            SELECT result_text AS r, count(*)::int AS n
            FROM activation_item
            WHERE status = 'failed' AND updated_at >= ${s} AND updated_at < ${e}
            GROUP BY 1`,
        prisma.$queryRaw<{ n: number }[]>`
            SELECT count(DISTINCT terminal_id)::int AS n
            FROM activation_item
            WHERE status IN ('activated', 'already_active') AND updated_at >= ${s} AND updated_at < ${e}`,
        prisma.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n
            FROM activation_item
            WHERE status = 'activated' AND updated_at >= ${ps} AND updated_at < ${pe}`,
    ]);

    const jobIds = Array.from(new Set(perJob.map((r) => r.job_id)));
    const [jobs, pendingNow] = await Promise.all([
        prisma.activation_job.findMany({
            where: { id: { in: jobIds } },
            include: { tag: { select: { id: true, name: true, app_user: { select: { name: true } } } } },
        }),
        jobIds.length
            ? prisma.activation_item.groupBy({
                by: ["job_id"],
                where: { job_id: { in: jobIds }, status: { in: ["pending", "sending"] } },
                _count: { _all: true },
            })
            : Promise.resolve([]),
    ]);
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const pendingByJob = new Map(pendingNow.map((p) => [p.job_id, p._count._all]));

    // ---- per tag ----
    type TagRow = {
        tagId: string; tagName: string; owner: string | null; eans: Set<string>; jobStatuses: Set<string>;
        activated: number; already_active: number; failed: number; pendingNow: number;
        first_at: Date | null; last_at: Date | null; jobIds: Set<string>;
    };
    const tags = new Map<string, TagRow>();
    const byEan = new Map<string, { activated: number; already_active: number; failed: number }>();

    for (const r of perJob) {
        const job = jobById.get(r.job_id);
        if (!job) continue;
        let t = tags.get(job.tag_id);
        if (!t) {
            t = {
                tagId: job.tag_id, tagName: job.tag.name, owner: job.tag.app_user?.name ?? null,
                eans: new Set(), jobStatuses: new Set(), activated: 0, already_active: 0, failed: 0, pendingNow: 0,
                first_at: null, last_at: null, jobIds: new Set(),
            };
            tags.set(job.tag_id, t);
        }
        t.eans.add(r.ean);
        t.jobStatuses.add(job.status);
        if (!t.jobIds.has(job.id)) {
            t.jobIds.add(job.id);
            t.pendingNow += pendingByJob.get(job.id) ?? 0;
        }
        (t as any)[r.status] += r.n;
        if (r.status !== "failed") {
            if (!t.first_at || r.first_at < t.first_at) t.first_at = r.first_at;
            if (!t.last_at || r.last_at > t.last_at) t.last_at = r.last_at;
        }

        const ean = byEan.get(r.ean) ?? { activated: 0, already_active: 0, failed: 0 };
        (ean as any)[r.status] += r.n;
        byEan.set(r.ean, ean);
    }

    // ---- per day (always 7 rows) ----
    const days = Array.from({ length: 7 }, (_, i) => ({ date: addDays(monday, i), activated: 0, already_active: 0, failed: 0 }));
    for (const r of perDay) {
        const d = days.find((x) => x.date === r.d);
        if (d && DONE.includes(r.status)) (d as any)[r.status] += r.n;
    }

    // ---- failure reasons ----
    const reasonMap = new Map<string, number>();
    for (const r of reasons) {
        const k = normalizeReason(r.r);
        reasonMap.set(k, (reasonMap.get(k) ?? 0) + r.n);
    }

    const tagRows = Array.from(tags.values())
        .map((t) => ({
            tagId: t.tagId,
            tagName: t.tagName,
            owner: t.owner,
            eans: Array.from(t.eans),
            jobStatus: t.jobStatuses.has("running") ? "running" : t.jobStatuses.has("paused") ? "paused"
                : t.jobStatuses.has("cancelled") ? "cancelled" : "finished",
            activated: t.activated,
            already_active: t.already_active,
            failed: t.failed,
            pendingNow: t.pendingNow,
            first_at: t.first_at,
            last_at: t.last_at,
        }))
        .sort((a, b) => b.activated - a.activated);

    const totals = tagRows.reduce(
        (acc, t) => ({
            activated: acc.activated + t.activated,
            already_active: acc.already_active + t.already_active,
            failed: acc.failed + t.failed,
            pendingNow: acc.pendingNow + t.pendingNow,
        }),
        { activated: 0, already_active: 0, failed: 0, pendingNow: 0 },
    );
    const attempted = totals.activated + totals.already_active + totals.failed;

    return {
        week,
        from: monday,
        to: addDays(monday, 6),
        prevWeek: isoWeekOf(prevMonday),
        nextWeek: isoWeekOf(nextMonday),
        thisWeek: isoWeekOf(berlinToday()),
        lastWeek: defaultReportWeek(),
        isCurrentOrFuture: nextMonday > berlinToday(),
        totals: {
            ...totals,
            tags: tagRows.length,
            terminals: terminals[0]?.n ?? 0,
            successRate: attempted ? (totals.activated + totals.already_active) / attempted : null,
            prevWeekActivated: prevWeek[0]?.n ?? 0,
        },
        days,
        byEan: Array.from(byEan.entries()).map(([ean, c]) => ({ ean, ...c })).sort((a, b) => b.activated - a.activated),
        reasons: Array.from(reasonMap.entries()).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 10),
        tags: tagRows,
    };
}
