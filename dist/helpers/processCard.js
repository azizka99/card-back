"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_s3_1 = require("@aws-sdk/client-s3");
const analizeImage_1 = require("./analizeImage");
const User_1 = require("../models/User");
const Tag_1 = require("../models/Tag");
const SteamCard_1 = require("../models/SteamCard");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const ErrorCard_1 = require("../models/ErrorCard");
const uuid_1 = require("uuid");
const processCard = async (card, s3, BUCKET) => {
    if (!card.img_src)
        return;
    const signedUrl = await (0, s3_request_presigner_1.getSignedUrl)(s3, new client_s3_1.GetObjectCommand({
        Bucket: BUCKET,
        Key: card.img_src,
    }), { expiresIn: 60 * 2 } // 2 minutes
    );
    const { cleanedText } = await (0, analizeImage_1.analyzeImage)(signedUrl);
    if (cleanedText !== card.activation_code) {
        const user = new User_1.User(card.app_user.id, card.app_user.email, card.app_user.name, card.app_user.role);
        const tag = new Tag_1.Tag(card.tag?.id, card.tag?.name, card.tag?.created_at);
        const steamCard = new SteamCard_1.SteamCard(card.id, card.activation_code, card.barcode, card.img_src, user, tag);
        // assuming createErrorCard is async – better to await
        await ErrorCard_1.ErrorCard.createErrorCard(new ErrorCard_1.ErrorCard((0, uuid_1.v4)(), cleanedText, card.id));
    }
};
