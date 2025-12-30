"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const clientRoutes_1 = __importDefault(require("./routes/client/clientRoutes"));
const errorMiddleware_1 = require("./middlewares/errorMiddleware");
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const User_1 = require("./models/User");
const path_1 = __importDefault(require("path"));
const express_session_1 = __importDefault(require("express-session"));
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const dbConnection_1 = __importDefault(require("./constants/dbConnection"));
const clientAuthMiddleware_1 = require("./middlewares/clientAuthMiddleware");
const clientAuthController_1 = require("./controllers/client/clientAuthController");
const uuid_1 = require("uuid");
const ErrorCard_1 = require("./models/ErrorCard");
const specialClientRoutes_1 = __importDefault(require("./routes/client/specialClientRoutes"));
const otplib_1 = require("otplib");
const qrcode_1 = __importDefault(require("qrcode"));
const app = (0, express_1.default)();
dotenv_1.default.config({ path: '.env' });
app.set("view engine", "ejs");
app.set("views", path_1.default.join(process.cwd(), "src/views"));
app.use((0, cors_1.default)());
app.use((0, cookie_parser_1.default)());
app.use(express_1.default.urlencoded({ extended: true }));
app.use(express_1.default.json());
app.use((0, express_session_1.default)({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 }, // 1h
}));
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASS = process.env.ADMIN_PASS || "supersecret";
function requireAuth(req, res, next) {
    if (req.session?.isAuthed)
        return next();
    res.redirect("/admin/login");
}
const REGION = process.env.AWS_REGION || "eu-central-1";
const BUCKET = process.env.AWS_BUCKET_NAME || "scanaras-steam-bucket";
const s3 = new client_s3_1.S3Client({ region: REGION });
app.get("/admin/login", (req, res) => {
    res.render("login", { error: null });
});
app.post("/admin/login", async (req, res) => {
    const { email, password } = req.body;
    if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
        // req.session.isAuthed = true;
        req.session.pending2fa = true;
        // Optional: store timestamp to expire quickly
        req.session.pending2faAt = Date.now();
        return res.redirect("/admin/2fa");
    }
    res.status(401).render("login", { error: "Invalid credentials" });
});
app.post("/admin/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/admin/login"));
});
// app.get("/admin", requireAuth, async (req, res) => {
//   const q = (req.query.q as string) || "";
//   const items = await prisma.steam_card.findMany({
//     where: q ? { barcode: { contains: q, mode: "insensitive" } } : {},
//     orderBy: { created_at: "desc" },
//     take: 200, // cap to keep page light
//     include: { tag: true, app_user: true },
//     // select: { id: true, barcode: true, activation_code: true, img_src: true, created_at: true, tag_id }
//   });
//   // console.log(items);
//   res.render("dashboard", { items, q });
// });
app.get("/admin", requireAuth, async (req, res) => {
    // 1. Get ALL three filter values from the query
    const q = req.query.q || "";
    const tag = req.query.tag || "";
    const user = req.query.user || "";
    // 2. Build the dynamic 'where' clause for Prisma
    const where = {};
    if (q) {
        // Filter by barcode on the main table
        where.barcode = { contains: q, mode: "insensitive" };
    }
    if (tag) {
        // Filter by the 'name' field on the RELATED 'tag' table
        where.tag = {
            name: { contains: tag, mode: "insensitive" }
        };
    }
    if (user) {
        // Filter by the 'name' field on the RELATED 'app_user' table
        where.app_user = {
            name: { contains: user, mode: "insensitive" }
        };
    }
    const allTags = await dbConnection_1.default.tag.findMany({
        orderBy: { created_at: "desc" },
    });
    const allUsers = await dbConnection_1.default.app_user.findMany({
        where: {
            role: 'client'
        },
        include: {
            tag: {
                orderBy: {
                    created_at: "desc"
                }
            }
        }
    });
    console.log(allUsers);
    // 3. Run the query with the combined 'where' filters
    const items = await dbConnection_1.default.steam_card.findMany({
        where: where, // Use the new dynamic 'where' object
        orderBy: { created_at: "desc" },
        take: 200,
        include: { tag: true, app_user: true }, // This is what gives you the data structure you showed!
    });
    // 4. FIX THE ERROR: Pass 'items', 'q', 'tag', AND 'user' to the template
    res.render("dashboard", { items, allUsers, q, tag, user, tags: allTags });
});
app.get("/admin/item/:id", requireAuth, async (req, res) => {
    const item = await dbConnection_1.default.steam_card.findUnique({
        where: { id: req.params.id },
        select: { id: true, barcode: true, activation_code: true, img_src: true, created_at: true }
    });
    if (!item)
        return res.status(404).send("Not found");
    // img_src stores the S3 key (e.g. 'scans/123-file.jpg')
    let signedUrl = null;
    if (item.img_src) {
        signedUrl = await (0, s3_request_presigner_1.getSignedUrl)(s3, new client_s3_1.GetObjectCommand({ Bucket: BUCKET, Key: item.img_src }), { expiresIn: 60 * 10 } // 10 minutes
        );
    }
    res.render("item", { item, signedUrl });
});
app.get("/admin/download-scans/:tag_id", requireAuth, async (req, res) => {
    const items = await dbConnection_1.default.steam_card.findMany({
        where: {
            tag_id: req.params.tag_id
        },
        select: {
            barcode: true,
            activation_code: true,
        }
    });
    if (!items) {
        res.status(404).send("Not Found");
    }
    res.render("download-cards", { items });
});
app.get("/admin/print-scans/:tag_id", requireAuth, async (req, res) => {
    const items = await dbConnection_1.default.steam_card.findMany({
        where: {
            tag_id: req.params.tag_id
        },
        select: {
            activation_code: true,
            barcode: true
        }
    });
    if (!items) {
        return res.status(404).send("Not Found");
    }
    res.render("print-cards", { items });
});
app.get("/admin/2fa/setup", async (req, res) => {
    // Protect this route (IP restriction + maybe temporary password)
    // Ideally: remove/disable after setup
    const label = "Scan App";
    const issuer = "Arascom"; // shown in authenticator app
    const secret = otplib_1.authenticator.generateSecret(); // base32
    const otpauth = otplib_1.authenticator.keyuri(label, issuer, secret);
    const qrDataUrl = await qrcode_1.default.toDataURL(otpauth);
    // IMPORTANT: print/store secret ONCE and then put it into env (ADMIN_TOTP_SECRET)
    res.send(`
    <h2>Scan this QR in Google Authenticator</h2>
    <img src="${qrDataUrl}" />
    <p><b>Secret (store in ADMIN_TOTP_SECRET):</b> ${secret}</p>
    <p>After saving it in env, delete/disable this route.</p>
  `);
});
app.get("/admin/2fa", (req, res) => {
    if (!req.session.pending2fa)
        return res.redirect("/admin/login");
    return res.render("2fa", { error: null });
});
app.post("/admin/2fa", (req, res) => {
    if (!req.session.pending2fa)
        return res.redirect("/admin/login");
    // Optional expiry (e.g. 2 minutes)
    if (Date.now() - (req.session.pending2faAt || 0) > 2 * 60 * 1000) {
        req.session.pending2fa = false;
        return res.redirect("/admin/login");
    }
    const { token } = req.body; // 6 digits from app
    const secret = process.env.ADMIN_TOTP_SECRET || "Helloo";
    // allow slight clock drift (otplib default window is 0; we can set window = 1)
    otplib_1.authenticator.options = { window: 1 };
    const ok = otplib_1.authenticator.check((token || "").replace(/\s/g, ""), secret);
    if (!ok) {
        return res.status(401).render("2fa", { error: "Invalid code" });
    }
    // Success: fully authenticated
    req.session.isAuthed = true;
    req.session.pending2fa = false;
    req.session.pending2faAt = null;
    return res.redirect("/admin");
});
app.use("/arascom-scan", clientAuthMiddleware_1.clientAuthMiddleWare, clientRoutes_1.default);
app.post("/test-start-end", async (req, res) => {
    const { start, end } = req.body;
    function luhnCheckDigit(payload15) {
        // payload15: string of 15 digits
        let sum = 0;
        // Walk from right to left over the payload
        for (let i = payload15.length - 1, posFromRight = 1; i >= 0; i--, posFromRight++) {
            let d = Number(payload15[i]);
            // Double every 1st,3rd,5th... position from the right (within the payload)
            if (posFromRight % 2 === 1) {
                d *= 2;
                if (d > 9)
                    d -= 9;
            }
            sum += d;
        }
        // Check digit makes (sum + check) % 10 === 0
        return String((10 - (sum % 10)) % 10);
    }
    function generateBarcodes(startCode, endCode) {
        if (!/^\d{16}$/.test(startCode) || !/^\d{16}$/.test(endCode)) {
            throw new Error("Start and end must be 16 digits.");
        }
        const startPayload = BigInt(startCode.slice(0, -1)); // first 15 digits
        const endPayload = BigInt(endCode.slice(0, -1));
        if (startPayload > endPayload) {
            throw new Error("Start must be <= end.");
        }
        const results = [];
        const width = 15; // payload length
        for (let core = startPayload; core <= endPayload; core++) {
            const coreStr = core.toString().padStart(width, "0");
            const check = luhnCheckDigit(coreStr);
            results.push(String(coreStr + check) + ",");
        }
        return results;
    }
    res.json({
        result: generateBarcodes(start, end)
    });
});
// app.post("/test-start-only", async (req, res) => {
//   const { start } = req.body;
//   function luhnCheckDigit(payload15: string): string {
//     let sum = 0;
//     for (let i = payload15.length - 1, posFromRight = 1; i >= 0; i--, posFromRight++) {
//       let d = Number(payload15[i]);
//       if (posFromRight % 2 === 1) {
//         d *= 2;
//         if (d > 9) d -= 9;
//       }
//       sum += d;
//     }
//     return String((10 - (sum % 10)) % 10);
//   }
//   // Generate exactly 200 barcodes from the 15-digit payload of `start`
//   function generateFixed200(startCode: string): string[] {
//     if (!/^\d{16}$/.test(startCode)) {
//       throw new Error("`start` must be exactly 16 digits.");
//     }
//     const width = 15; // payload length
//     let core = BigInt(startCode.slice(0, -1)); // work on the first 15 digits
//     const results: string[] = [];
//     for (let i = 0; i < 200; i++) {
//       const coreStr = core.toString().padStart(width, "0");
//       const check = luhnCheckDigit(coreStr);
//       results.push(coreStr + check);
//       core += 1n;
//       // prevent overflow beyond 15 digits
//       if (core > 999999999999999n && i < 199) {
//         throw new Error("Reached the maximum 15-digit payload limit.");
//       }
//     }
//     return results;
//   }
//   res.json({
//     result: generateFixed200(start)
//   })
// });
app.use('/special-client', specialClientRoutes_1.default);
app.post("/client-login", clientAuthController_1.login);
app.post("/login", (0, express_async_handler_1.default)(async (req, res) => {
    const { email } = req.body;
    const user = await User_1.User.findUserByEmail(email);
    if (!user) {
        res.json({ result: null, error: "No such user found" });
        return;
    }
}));
app.get("/app/update.json", (req, res) => {
    const latestVersion = {
        versionCode: 7,
        versionName: "3.1.1",
        apkUrl: "https://arascom-public-access-files.s3.eu-central-1.amazonaws.com/app/app-release.apk"
    };
    res.json(latestVersion);
});
app.get("/test-error", (0, express_async_handler_1.default)(async (req, res) => {
    const testError = await ErrorCard_1.ErrorCard.createErrorCard(new ErrorCard_1.ErrorCard((0, uuid_1.v4)(), 'test', '1d3a265f-c59d-4343-bb34-506c273f9b8f'));
    res.json(testError);
}));
app.use(errorMiddleware_1.notFound);
app.use(errorMiddleware_1.errorHandler);
app.listen(process.env.APP_PORT || 5500, () => {
    console.log("ArascomScan Backend Has Started");
    console.log(`Server is running at ${process.env.NODE_ENV} mode and at port |${process.env.APP_PORT}|`);
    console.log('Server mode: ' + process.env.NODE_ENV);
    console.log('Database url: ' + process.env.DATABASE_URL);
    console.log("------------------------------------------------------------");
});
