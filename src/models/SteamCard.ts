import isUndefined from "../helpers/isUndefined";
import { validate as isUuid } from "uuid";
import { User } from "./User";
import prisma from "../constants/dbConnection";
import { Tag } from "./Tag";

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
}