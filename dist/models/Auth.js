"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.Auth = void 0;
const isUndefined_1 = __importDefault(require("../helpers/isUndefined"));
const uuid_1 = require("uuid");
const uuid_2 = require("uuid");
class Auth {
    constructor(_id, _otp, _token, _otpCreatedAt, _tokenCreatedAt, _user) {
        this.getAuth = () => {
            return {
                id: this.id,
                otp: this.otp,
                token: this.token,
                otpCreatedAt: this.otpCreatedAt,
                tokenCreatedAt: this.tokenCreatedAt,
                user: this.user
            };
        };
        (0, isUndefined_1.default)({ id: _id }, { otp: _otp }, { token: _token }, { otpCreatedAt: _otpCreatedAt }, { tokenCreatedAt: _tokenCreatedAt });
        if (!(0, uuid_1.validate)(_id)) {
            throw new Error("Invalid UUID format");
        }
        ;
        this.id = _id;
        this.otp = _otp;
        this.token = _token;
        this.otpCreatedAt = _otpCreatedAt;
        this.tokenCreatedAt = _tokenCreatedAt;
        this.user = _user;
    }
}
exports.Auth = Auth;
_a = Auth;
Auth.generateOtp = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};
Auth.sendOtp = (_email) => {
    const generatedOtp = _a.generateOtp();
    const otpId = (0, uuid_2.v4)();
    const otpCreatedAt = new Date();
};
