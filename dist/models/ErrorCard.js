"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorCard = void 0;
const dbConnection_1 = __importDefault(require("../constants/dbConnection"));
const isUndefined_1 = __importDefault(require("../helpers/isUndefined"));
const uuid_1 = require("uuid");
class ErrorCard {
    constructor(_id, _googleAnswer, _steamCardId, _steamCard) {
        this.getErrorCard = () => {
            return {
                id: this.id,
                googleAnswer: this.googleAnswer,
                steamCard: this.steamCard
            };
        };
        (0, isUndefined_1.default)({ id: _id }, { googleAnswer: _googleAnswer });
        if (!uuid_1.validate) {
            throw new Error("Invalid UUID format");
        }
        ;
        this.id = _id;
        this.googleAnswer = _googleAnswer;
        this.steamCard = _steamCard;
        this.steamCardId = _steamCardId;
    }
}
exports.ErrorCard = ErrorCard;
_a = ErrorCard;
ErrorCard.createErrorCard = async (card) => {
    const errorCard = await dbConnection_1.default.errorCard.create({
        data: {
            id: card.id,
            googleanswer: card.googleAnswer,
            steam_card_id: card.steamCardId
        }
    });
    return errorCard;
};
ErrorCard.getErrorCardsByTagId = async (tag_id) => {
    const errorTags = await dbConnection_1.default.errorCard.findMany({
        where: {
            steam_card: {
                tag_id: tag_id
            }
        }
    });
    return errorTags;
};
