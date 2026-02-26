import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import clientRoutes from "./routes/client/clientRoutes";
import { errorHandler, notFound } from "./middlewares/errorMiddleware";
import expressAsyncHandler from "express-async-handler";
import { User } from "./models/User";
import path from "path";
import session from "express-session";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import prisma from "./constants/dbConnection";
import { clientAuthMiddleWare } from "./middlewares/clientAuthMiddleware";
import { login } from "./controllers/client/clientAuthController";
import { v4 as uuidv4 } from "uuid";
import { ErrorCard } from "./models/ErrorCard";
import special_client from "./routes/client/specialClientRoutes";
import { authenticator } from "otplib";
import adminRoutes from "./routes/admin/adminRoutes";
import { requireMagic } from "./middlewares/requireMagicMiddleware";
import testRoutes from "./controllers/client/testRoute";



const app = express();
dotenv.config({ path: '.env' });

app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "src/views"));

app.use(cors());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 }, // 1h
  })
);

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASS = process.env.ADMIN_PASS || "supersecret";

function requireAuth(req: any, res: any, next: any) {
  if (req.session?.isAuthed) return next();
  res.redirect("/admin/login");
}

// async function requireMagic(req: any, res: any, next: any) {
//   if (!req.params.magic_id) {
//     res.json({ "Error": "Forbidden!" })
//     return;
//   }

//   const magic = await prisma.magic_link.findUnique({
//     where: {
//       id: req.params.magic_id
//     }
//   });

//   if (!magic) {
//     res.json({ "Error": "Forbidden!" })
//     return;
//   }

//   next();
// }



const REGION = process.env.AWS_REGION || "eu-central-1";
const BUCKET = process.env.AWS_BUCKET_NAME || "scanaras-steam-bucket";
const s3 = new S3Client({ region: REGION });

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


app.get("/admin/m/:magic_id", requireMagic, async (req, res) => {
  // 1. Get ALL three filter values from the query
  const q = (req.query.q as string) || "";
  const tag = (req.query.tag as string) || "";
  const user = (req.query.user as string) || "";

  // 2. Build the dynamic 'where' clause for Prisma
  const where: any = {};

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

  const allTags = await prisma.tag.findMany({
    orderBy: { created_at: "desc" },
  });

  const allUsers = await prisma.app_user.findMany({
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



  // 3. Run the query with the combined 'where' filters
  const items = await prisma.steam_card.findMany({
    where: where, // Use the new dynamic 'where' object
    orderBy: { created_at: "desc" },
    take: 200,
    include: { tag: true, app_user: true }, // This is what gives you the data structure you showed!
  });

  // 4. FIX THE ERROR: Pass 'items', 'q', 'tag', AND 'user' to the template
  res.render("dashboard", { items, allUsers, q, tag, user, tags: allTags, magic_id: req.params.magic_id });
});



//duzelt sonra bunu
app.get("/admin/item/:id", async (req, res) => {
  const item = await prisma.steam_card.findUnique({
    where: { id: req.params.id },
    select: { id: true, barcode: true, activation_code: true, img_src: true, created_at: true }
  });
  if (!item) return res.status(404).send("Not found");

  // img_src stores the S3 key (e.g. 'scans/123-file.jpg')
  let signedUrl: string | null = null;
  if (item.img_src) {
    signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: item.img_src }),
      { expiresIn: 60 * 10 } // 10 minutes
    );
  }

  res.render("item", { item, signedUrl });
});


app.get("/admin/download-scans/:tag_id", requireAuth, async (req, res) => {
  const items = await prisma.steam_card.findMany({
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
  const items = await prisma.steam_card.findMany({
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

  res.render("print-cards", { items })
});

// app.get("/admin/2fa/setup", async (req, res) => {
//   // Protect this route (IP restriction + maybe temporary password)
//   // Ideally: remove/disable after setup

//   const label = "Scan App"

//   const issuer = "Arascom"; // shown in authenticator app

//   const secret = authenticator.generateSecret(); // base32

//   const otpauth = authenticator.keyuri(label, issuer, secret);

//   const qrDataUrl = await QRCode.toDataURL(otpauth);

//   // IMPORTANT: print/store secret ONCE and then put it into env (ADMIN_TOTP_SECRET)
//   res.send(`
//     <h2>Scan this QR in Google Authenticator</h2>
//     <img src="${qrDataUrl}" />
//     <p><b>Secret (store in ADMIN_TOTP_SECRET):</b> ${secret}</p>
//     <p>After saving it in env, delete/disable this route.</p>
//   `);
// });


app.get("/admin/2fa", (req, res) => {
  if (!req.session.pending2fa) return res.redirect("/admin/login");
  return res.render("2fa", { error: null });
});


app.post("/admin/2fa", (req, res) => {
  if (!req.session.pending2fa) return res.redirect("/admin/login");

  // Optional expiry (e.g. 2 minutes)
  if (Date.now() - (req.session.pending2faAt || 0) > 2 * 60 * 1000) {
    req.session.pending2fa = false;
    return res.redirect("/admin/login");
  }

  const { token } = req.body; // 6 digits from app
  const secret = process.env.ADMIN_TOTP_SECRET || "Helloo";

  // allow slight clock drift (otplib default window is 0; we can set window = 1)
  // authenticator.options = { window: 1 };

  const ok = authenticator.check((token || "").replace(/\s/g, ""), secret);

  if (!ok) {
    return res.status(401).render("2fa", { error: "Invalid code" });
  }

  // Success: fully authenticated
  req.session.isAuthed = true;
  req.session.pending2fa = false;
  req.session.pending2faAt = null;

  return res.redirect("/a26ae3e19a140048efd2/dashboard");
});

app.use("/arascom-scan", clientAuthMiddleWare, clientRoutes);


app.post("/test-start-end", async (req, res) => {
  const { start, end } = req.body;
  function luhnCheckDigit(payload15: any) {
    // payload15: string of 15 digits
    let sum = 0;
    // Walk from right to left over the payload
    for (let i = payload15.length - 1, posFromRight = 1; i >= 0; i--, posFromRight++) {
      let d = Number(payload15[i]);
      // Double every 1st,3rd,5th... position from the right (within the payload)
      if (posFromRight % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    // Check digit makes (sum + check) % 10 === 0
    return String((10 - (sum % 10)) % 10);
  }

  function generateBarcodes(startCode: any, endCode: any) {
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
  })
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

app.use('/special-client', special_client);


app.post("/client-login", login);

app.use("/a26ae3e19a140048efd2", requireAuth, adminRoutes);

app.post("/login", expressAsyncHandler(async (req, res) => {
  const { email } = req.body;

  const user = await User.findUserByEmail(email);

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


app.get("/test-error", expressAsyncHandler(async (req, res) => {

  const testError = await ErrorCard.createErrorCard(new ErrorCard(uuidv4(), 'test', '1d3a265f-c59d-4343-bb34-506c273f9b8f'))
  res.json(testError)
}));

app.use("/test",testRoutes);

// app.post(
//   "/test-barcodes",
//   express.text({ type: "*/*", limit: "20mb" }),
//   expressAsyncHandler(async (req, res) => {
//     // 1️⃣ Raw text → array
//     const raw = (req.body ?? "").toString();

//     const barcodes = raw
//       .split(/\r?\n/)
//       .map(l => l.trim())
//       .filter(Boolean);

//     // 2️⃣ Validate + dedupe
//     const cleanBarcodes = Array.from(new Set(barcodes)).filter(b =>
//       /^\d{16}$/.test(b)
//     );

//     const CHUNK_SIZE = 1000;
//     const chunks: string[][] = [];
//     for (let i = 0; i < cleanBarcodes.length; i += CHUNK_SIZE) {
//       chunks.push(cleanBarcodes.slice(i, i + CHUNK_SIZE));
//     }

//     // 3️⃣ Store barcode → activation_code
//     let missingMap: Map<string, string> | null = null;

//     //99b21fc0-be12-4942-b8e2-54e2c4823ba2
//     for (const chunk of chunks) {
//       const result = await prisma.steam_card.findMany({
//         where: {
//           tag_id: "99b21fc0-be12-4942-b8e2-54e2c4823ba2",
//           barcode: { notIn: chunk },
//         },
//         select: {
//           barcode: true,
//           activation_code: true,
//         },
//       });

//       const resultMap = new Map(
//         result.map(r => [r.barcode, r.activation_code])
//       );

//       if (missingMap === null) {
//         missingMap = resultMap;
//       } else {
//         // intersection by barcode
//         missingMap = new Map(
//           [...missingMap].filter(([barcode]) => resultMap.has(barcode))
//         );
//       }
//     }

//     // 4️⃣ Final output as "barcode,activation_code"
//     const output = [...(missingMap ?? [])].map(
//       ([barcode, activationCode]) => `${barcode},${activationCode}`
//     );

//     // 👉 BEST for copy-paste (plain text)
//     res
//       .type("text/plain")
//       .send(output.join("\n"));
//   })
// );

app.use(notFound);
app.use(errorHandler);






app.listen(process.env.APP_PORT || 5500, () => {
  console.log("ArascomScan Backend Has Started");
  console.log(`Server is running at ${process.env.NODE_ENV} mode and at port |${process.env.APP_PORT}|`);
  console.log('Server mode: ' + process.env.NODE_ENV);
  console.log('Database url: ' + process.env.DATABASE_URL);

  console.log("------------------------------------------------------------");
});

