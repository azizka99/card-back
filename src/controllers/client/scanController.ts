
import expressAsyncHandler from "express-async-handler";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SteamCard } from "../../models/SteamCard";
import { User } from "../../models/User";

const REGION = process.env.AWS_REGION || "eu-central-1";
const BUCKET = process.env.AWS_BUCKET_NAME || "scanaras-steam-bucket";
const s3 = new S3Client({ region: REGION });

export const createScan = expressAsyncHandler(async(req,res)=>{
    const file = req.file; 
    const {id, activationCode, barCode} = req.body;
    try {
       

        if (!file) {
            throw new Error("No file Sent");
        }

       
    
        // Generate a clean key/path
        const key = `scans/${Date.now()}-${file?.originalname.replace(/\s+/g, "_")}`;
    
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype
          })
        );

        const user = await User.findUserByEmail("azizka.ibragimov@gmail.com");
    
        const scannedSteam = new SteamCard(id, activationCode,barCode,key, user);

        const send = await SteamCard.createSteamCard(scannedSteam);

        

    
        res.json({error:null, result: "Added!"});
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Upload failed" });
      }

    
});