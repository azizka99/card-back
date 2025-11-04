"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SteamCard = void 0;
const isUndefined_1 = __importDefault(require("../helpers/isUndefined"));
const uuid_1 = require("uuid");
const dbConnection_1 = __importDefault(require("../constants/dbConnection"));
class SteamCard {
    constructor(_id, _activationCode, _barCode, _imgSrc, _user) {
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
            user_id: steam.user.getUser().id
        }
    });
};
