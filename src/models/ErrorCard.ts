import prisma from "../constants/dbConnection";
import isUndefined from "../helpers/isUndefined";
import { SteamCard } from "./SteamCard";
import { validate as isUuid } from "uuid";

export class ErrorCard {
    private id: string;
    private googleAnswer: string;
    private steamCard?: SteamCard;
    private steamCardId: string;


    constructor(_id: string, _googleAnswer: string, _steamCardId: string, _steamCard?: SteamCard,) {
        isUndefined(
            { id: _id },
            { googleAnswer: _googleAnswer }
        );

        if (!isUuid) {
            throw new Error("Invalid UUID format");
        };

        this.id = _id;
        this.googleAnswer = _googleAnswer;
        this.steamCard = _steamCard;
        this.steamCardId = _steamCardId;
    }

    public getErrorCard = () => {
        return {
            id: this.id,
            googleAnswer: this.googleAnswer,
            steamCard: this.steamCard
        };
    };

    public static createErrorCard = async (card: ErrorCard) => {
        const errorCard = await prisma.errorCard.create(
            {
                data: {
                    id: card.id,
                    googleanswer: card.googleAnswer,
                    steam_card_id: card.steamCardId
                }
            }
        );
        return errorCard;
    }

    public static getErrorCardsByTagId = async (tag_id: string) => {
        const errorTags = await prisma.errorCard.findMany({
            where: {
                steam_card: {
                    tag_id: tag_id
                }
            }
        });

        return errorTags;
    }

}