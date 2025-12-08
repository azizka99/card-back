
import expressAsyncHandler from "express-async-handler";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { SteamCard } from "../../models/SteamCard";
import { User } from "../../models/User";
import { Prisma } from "@prisma/client";
import { Tag } from "../../models/Tag";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const REGION = process.env.AWS_REGION || "eu-central-1";
const BUCKET = process.env.AWS_BUCKET_NAME || "scanaras-steam-bucket";
const s3 = new S3Client({ region: REGION });

export const createScan = expressAsyncHandler(async (req, res) => {
  const file = req.file;
  const { id, activationCode, barCode, userId, tagId } = req.body;
  try {


    if (!file) {
      throw new Error("No file Sent");
    }



    // Generate a clean key/path
    const key = `scans/${Date.now()}-${barCode}-${file?.originalname.replace(/\s+/g, "_",)}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype
      })
    );

    const user = await User.findUserById(userId);
    const tag = await Tag.findTagById(tagId);

    if (!user) {
      throw new Error(`User with email ${userId} not found`);
    }
    if (!tag) {
      throw new Error(`Tag with with Id ${userId} not found`);
    }

    const scannedSteam = new SteamCard(id, activationCode, barCode, key, user, new Tag(tag.id, tag.name, tag.created_at));

    const send = await SteamCard.createSteamCard(scannedSteam);




    res.json({ error: null, result: "Added!" });
  } catch (e: any) {
    // ✅ Handle Prisma unique constraint violations cleanly
    if (
      (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
      e?.code === "P2002"
    ) {
      // e.meta?.target often includes the field(s) that violated the constraint
      const fields = (e.meta?.target as string[] | string | undefined) ?? [];
      const fieldList = Array.isArray(fields) ? fields : [fields].filter(Boolean);

      // Build a short, client-friendly message (matches your Flutter detector)
      const msg =
        fieldList.length === 1
          ? `${fieldList[0]} already scanned`
          : `already scanned`;

      res.status(409).json({
        error: "already scanned",
        details: msg,
        fields: fieldList,
      });
      return
    }

    console.error(e);
    res.status(500).json({ error: "Upload failed" });
    return;
  }
});


export const getScannedCardsByTagId = expressAsyncHandler(async (req, res) => {
  const { tagId } = req.body;

  if (!tagId) {
    res.json({ result: null, error: "No tagId" });
    return;
  }

  const cards = await SteamCard.getSteamCardsByTagId(tagId);
  let signedUrl: string | null = null;
  const steamCards = [];

  for (const i in cards) {
    if (cards[i].img_src) {
      signedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: cards[i].img_src }),
        { expiresIn: 60 * 10 } // 10 minutes
      );
      steamCards.push({
        activation_code: cards[i].activation_code,
        barcode: cards[i].barcode,
        img_src: signedUrl
      })
    }
  }

  res.json({ error: null, result: steamCards })
});


export const editSteamCard = expressAsyncHandler(async (req, res) => {
  const { id, barcode, activation_code } = req.body;

  if (!id || !barcode || !activation_code) {
    res.json({
      error: "there is something missing, id|barcode|activation-cde"
    });
    return;
  }

  const card = await SteamCard.editSteamCardById(id, barcode, activation_code);

  res.json({
    error: null,
    result: "edited"
  });
});