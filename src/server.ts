import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import clientRoutes from "./routes/client/clientRoutes";
import { errorHandler, notFound } from "./middlewares/errorMiddleware";
import expressAsyncHandler from "express-async-handler";
import { User } from "./models/User";


const app = express();

dotenv.config({ path: '.env' });


app.use(cors());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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