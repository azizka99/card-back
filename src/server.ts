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
const ADMIN_PASS  = process.env.ADMIN_PASS  || "supersecret";

function requireAuth(req: any, res: any, next: any) {
  if (req.session?.isAuthed) return next();
  res.redirect("/admin/login");
}

const REGION = process.env.AWS_REGION || "eu-central-1";
const BUCKET = process.env.AWS_BUCKET_NAME || "scanaras-steam-bucket";
const s3 = new S3Client({ region: REGION });

app.get("/admin/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/admin/login", async (req, res) => {
  const { email, password } = req.body;
  if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
    req.session.isAuthed = true;
    return res.redirect("/admin");
  }
  res.status(401).render("login", { error: "Invalid credentials" });
});

app.post("/admin/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

app.get("/admin", requireAuth, async (req, res) => {
  const q = (req.query.q as string) || "";

  const items = await prisma.steam_card.findMany({
    where: q ? { barcode: { contains: q, mode: "insensitive" } } : {},
    orderBy: { created_at: "desc" },
    take: 200, // cap to keep page light
    select: { id: true, barcode: true, activation_code: true, img_src: true, created_at: true }
  });

  res.render("dashboard", { items, q });
});

app.get("/admin/item/:id", requireAuth, async (req, res) => {
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




app.use("/arascom-scan", clientRoutes);


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


app.post("/test-start-only", async (req, res) => {
  const { start } = req.body;

  function luhnCheckDigit(payload15: string): string {
    let sum = 0;
    for (let i = payload15.length - 1, posFromRight = 1; i >= 0; i--, posFromRight++) {
      let d = Number(payload15[i]);
      if (posFromRight % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return String((10 - (sum % 10)) % 10);
  }

  // Generate exactly 200 barcodes from the 15-digit payload of `start`
  function generateFixed200(startCode: string): string[] {
    if (!/^\d{16}$/.test(startCode)) {
      throw new Error("`start` must be exactly 16 digits.");
    }

    const width = 15; // payload length
    let core = BigInt(startCode.slice(0, -1)); // work on the first 15 digits
    const results: string[] = [];

    for (let i = 0; i < 200; i++) {
      const coreStr = core.toString().padStart(width, "0");
      const check = luhnCheckDigit(coreStr);
      results.push(coreStr + check);
      core += 1n;

      // prevent overflow beyond 15 digits
      if (core > 999999999999999n && i < 199) {
        throw new Error("Reached the maximum 15-digit payload limit.");
      }
    }

    return results;
  }

  res.json({
    result: generateFixed200(start)
  })
});

app.post("/login", expressAsyncHandler(async (req, res) => {
  const { email } = req.body;

  const user = await User.findUserByEmail(email);

  if (!user) {
    res.json({ result: null, error: "No such user found" });
    return;
  }



}));


app.use(notFound);
app.use(errorHandler);


app.listen(process.env.APP_PORT || 5500, () => {
  console.log("ArascomScan Backend Has Started");
  console.log(`Server is running at ${process.env.NODE_ENV} mode and at port |${process.env.APP_PORT}|`);
  console.log('Server mode: ' + process.env.NODE_ENV);
  console.log('Database url: ' + process.env.DATABASE_URL);

  console.log("------------------------------------------------------------");
});