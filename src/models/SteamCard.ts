import isUndefined from "../helpers/isUndefined";
import { validate as isUuid } from "uuid";
import { User } from "./User";
import prisma from "../constants/dbConnection";
import { Tag } from "./Tag";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { analyzeImage } from "../helpers/analizeImage";
import { ErrorCard } from "./ErrorCard";
import { v4 as uuidv4 } from "uuid";


export class SteamCard {
    private id: string;
    private activationCode: string;
    private barCode: string;
    private imgSrc: string;
    private user: User;
    private tag: Tag;


    constructor(_id: string, _activationCode: string, _barCode: string, _imgSrc: string, _user: User, _tag: Tag) {
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
        const createdSteam = await prisma.steam_card.create({
            data: {
                id: steam.id,
                activation_code: steam.activationCode,
                barcode: steam.barCode,
                img_src: steam.imgSrc,
                user_id: steam.user.getUser().id,
                tag_id: steam.tag.getTag().id
            }
        })
    }

    public static checkErrorsByTagId = async (_tagId: string) => {
        const REGION = process.env.AWS_REGION || "eu-central-1";
        const BUCKET = process.env.AWS_BUCKET_NAME || "scanaras-steam-bucket";
        const s3 = new S3Client({ region: REGION });

        const cards = await prisma.steam_card.findMany({
            where: {
                tag_id: _tagId
            },
            include: {
                app_user: true,
                tag: true
            }
        });

        for (const i in cards) {
            let signedUrl: string | null = null;

            if (cards[i].img_src) {
                signedUrl = await getSignedUrl(
                    s3,
                    new GetObjectCommand({
                        Bucket: BUCKET, Key: cards[i].img_src
                    }),
                    { expiresIn: 60 * 2 } //2 minutes
                )

                const { cleanedText } = await analyzeImage(signedUrl);
                if (cleanedText !== cards[i].activation_code) {
                    const user = new User(cards[i].app_user.id, cards[i].app_user.email, cards[i].app_user.name, cards[i].app_user.role)
                    const tag = new Tag(cards[i].tag?.id as string, cards[i].tag?.name as string, cards[i].tag?.created_at as Date)
                    ErrorCard.createErrorCard(new ErrorCard(uuidv4(), cleanedText, new SteamCard(
                        cards[i].id, cards[i].activation_code, cards[i].barcode, cards[i].img_src, user, tag)));
                }
            }

        }

    }
}