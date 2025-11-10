"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SteamCard = void 0;
const isUndefined_1 = __importDefault(require("../helpers/isUndefined"));
const uuid_1 = require("uuid");
const User_1 = require("./User");
const dbConnection_1 = __importDefault(require("../constants/dbConnection"));
const Tag_1 = require("./Tag");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const client_s3_1 = require("@aws-sdk/client-s3");
const analizeImage_1 = require("../helpers/analizeImage");
const ErrorCard_1 = require("./ErrorCard");
const uuid_2 = require("uuid");
class SteamCard {
    constructor(_id, _activationCode, _barCode, _imgSrc, _user, _tag) {
        this.getSteamCard = () => {
            return {
                id: this.id,
                activationCode: this.activationCode,
                barCode: this.barCode,
                imgSrc: this.imgSrc,
                user: this.user
            };
        };
        (0, isUndefined_1.default)({ id: _id }, { activationCode: _activationCode }, { barCode: _barCode }, { imgSrc: _imgSrc });
        if (!(0, uuid_1.validate)(_id)) {
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
    }
    ;
}
exports.SteamCard = SteamCard;
_a = SteamCard;
SteamCard.createSteamCard = async (steam) => {
    const createdSteam = await dbConnection_1.default.steam_card.create({
        data: {
            id: steam.id,
            activation_code: steam.activationCode,
            barcode: steam.barCode,
            img_src: steam.imgSrc,
            user_id: steam.user.getUser().id,
            tag_id: steam.tag.getTag().id
        }
    });
};
SteamCard.checkErrorsByTagId = async (_tagId) => {
    const REGION = process.env.AWS_REGION || "eu-central-1";
    const BUCKET = process.env.AWS_BUCKET_NAME || "scanaras-steam-bucket";
    const s3 = new client_s3_1.S3Client({ region: REGION });
    const cards = await dbConnection_1.default.steam_card.findMany({
        where: {
            tag_id: _tagId
        },
        include: {
            app_user: true,
            tag: true
        }
    });
    for (const i in cards) {
        let signedUrl = null;
        if (cards[i].img_src) {
            signedUrl = await (0, s3_request_presigner_1.getSignedUrl)(s3, new client_s3_1.GetObjectCommand({
                Bucket: BUCKET, Key: cards[i].img_src
            }), { expiresIn: 60 * 2 } //2 minutes
            );
            const { cleanedText } = await (0, analizeImage_1.analyzeImage)(signedUrl);
            if (cleanedText !== cards[i].activation_code) {
                const user = new User_1.User(cards[i].app_user.id, cards[i].app_user.email, cards[i].app_user.name, cards[i].app_user.role);
                const tag = new Tag_1.Tag(cards[i].tag?.id, cards[i].tag?.name, cards[i].tag?.created_at);
                ErrorCard_1.ErrorCard.createErrorCard(new ErrorCard_1.ErrorCard((0, uuid_2.v4)(), cleanedText, new _a(cards[i].id, cards[i].activation_code, cards[i].barcode, cards[i].img_src, user, tag)));
            }
        }
    }
};
