import isUndefined from "../helpers/isUndefined";
import { validate as isUuid } from "uuid";
import { User } from "./User";
import prisma from "../constants/dbConnection";
import { Tag } from "./Tag";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { analyzeImage, equalsIgnoringLToI } from "../helpers/analizeImage";
import { ErrorCard } from "./ErrorCard";
import { v4 as uuidv4 } from "uuid";
import { Pack } from "./Pack";


export class SteamCard {
    private id: string;
    private activationCode: string;
    private barCode: string;
    private imgSrc: string;
    private user: User;
    private tag: Tag;
    private pack?: Pack;


    constructor(_id: string, _activationCode: string, _barCode: string, _imgSrc: string, _user: User, _tag: Tag, _pack?: Pack) {
        isUndefined(
            { id: _id },
            { activationCode: _activationCode },
            { barCode: _barCode },
            { imgSrc: _imgSrc }
        );

        if (!isUuid(_id)) {
            throw new Error("Invalid UUID format");
        }

        if (_activationCode.length === 0 || _activationCode.length > 20) {
            throw new Error("ActivationsCode's length should be more than 0 and less than 20");
        }

        if (_barCode.length === 0 || _barCode.length > 20) {
            throw new Error("Barcode's length should be more than 0 and less than 20");
        }

        if (_imgSrc.length === 0 || _imgSrc.length > 500) {
            throw new Error("ImgSrc's length should be more than 0 and less than 500");
        }

        this.id = _id;
        this.activationCode = _activationCode;
        this.barCode = _barCode;
        this.imgSrc = _imgSrc;
        this.user = _user;
        this.tag = _tag;
    };

    public getSteamCard = () => {
        return {
            id: this.id,
            activationCode: this.activationCode,
            barCode: this.barCode,
            imgSrc: this.imgSrc,
            user: this.user
        }
    }



    public static createSteamCard = async (steam: SteamCard) => {
        console.log('steam', steam);

        const data: any = {
            id: steam.id,
            activation_code: steam.activationCode,
            barcode: steam.barCode,
            img_src: steam.imgSrc,
            user_id: steam.user.getUser().id,
            tag_id: steam.tag.getTag().id,
            pack_id: steam.pack?.getPack().id || null
        }
        if (steam.pack) {
            data.pack_id = steam.pack.id;              // or steam.pack.getPack().id
        }
        const createdSteam = await prisma.steam_card.create({
            data
        });
    }

    public static checkErrorsByTagId = async (_tagId: string) => {
        const REGION = process.env.AWS_REGION || "eu-central-1";
        const BUCKET = process.env.AWS_BUCKET_NAME || "scanaras-steam-bucket";
        const s3 = new S3Client({ region: REGION });

        const cards = await prisma.steam_card.findMany({
            where: {
                tag_id: _tagId,
            },
            include: {
                app_user: true,
                tag: true,
            },
        });


        const processCard = async (card: any) => {
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

            const isSame = equalsIgnoringLToI(card.activation_code, cleanedText);
            if (!isSame) {
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

                await ErrorCard.createErrorCard(
                    new ErrorCard(uuidv4(), cleanedText, card.id)
                );
            }
        };

        // 🔥 run N cards in parallel at a time
        const MAX_CONCURRENT = 5; // tweak this (5–10 is usually safe)

        for (let i = 0; i < cards.length; i += MAX_CONCURRENT) {
            const chunk = cards.slice(i, i + MAX_CONCURRENT);

            await Promise.all(
                chunk.map((card) =>
                    processCard(card).catch((err) => {
                        console.error("Error processing card", card.id, err);
                    })
                )
            );
        }
    };

    public static getSteamCardsByTagId = async (_tagId: string) => {
        const cards = await prisma.steam_card.findMany({
            where: {
                tag_id: _tagId
            }, orderBy: {
                created_at: 'desc'
            },
            take: 300
        });
        return cards;
    }

    public static editSteamCardById = async (_id: string, _barcode: string, _activation_code: string) => {
        const card = await prisma.steam_card.update({
            where: {
                id: _id
            },
            data: {
                barcode: _barcode,
                activation_code: _activation_code
            }
        });

        return card;
    }

    public static deleteSteamCardById = async (_id: string) => {
        const deleted = await prisma.steam_card.delete({
            where: {
                id: _id
            }
        });

        return deleted;
    }
}