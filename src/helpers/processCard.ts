import { GetObjectCommand, S3Client, } from "@aws-sdk/client-s3";
import { analyzeImage } from "./analizeImage";
import { User } from "../models/User";
import { Tag } from "../models/Tag";
import { SteamCard } from "../models/SteamCard";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ErrorCard } from "../models/ErrorCard";
import { v4 as uuidv4 } from "uuid";

const processCard = async (card: any, s3: S3Client, BUCKET: string) => {
    if (!card.img_src) return;

    const signedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
            Bucket: BUCKET,
            Key: card.img_src,
        }),
        { expiresIn: 60 * 2 } // 2 minutes
    );

    const { cleanedText } = await analyzeImage(signedUrl);

    if (cleanedText !== card.activation_code) {
        const user = new User(
            card.app_user.id,
            card.app_user.email,
            card.app_user.name,
            card.app_user.role
        );

        const tag = new Tag(
            card.tag?.id as string,
            card.tag?.name as string,
            card.tag?.created_at as Date
        );

        const steamCard = new SteamCard(
            card.id,
            card.activation_code,
            card.barcode,
            card.img_src,
            user,
            tag
        );

        // assuming createErrorCard is async – better to await
        await ErrorCard.createErrorCard(
            new ErrorCard(uuidv4(), cleanedText, card.id)
        );
    }
};