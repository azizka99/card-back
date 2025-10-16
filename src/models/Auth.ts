import isUndefined from "../helpers/isUndefined";
import { User } from "./User";
import { validate as isUuid } from "uuid";
import nodemailer from "nodemailer";
import { v4 as uuidv4 } from "uuid";

export class Auth {
    private id:string;
    private otp:string;
    private token:string;
    private otpCreatedAt:Date;
    private tokenCreatedAt:Date;
    private user:User;

    constructor(_id:string, _otp:string,_token:string,_otpCreatedAt:Date,_tokenCreatedAt:Date, _user:User) {
        
        isUndefined(
            {id:_id},
            {otp:_otp},
            {token:_token},
            {otpCreatedAt:_otpCreatedAt},
            {tokenCreatedAt:_tokenCreatedAt}
        );

        if(!isUuid(_id)){
            throw new Error("Invalid UUID format");
        };

        this.id=_id;
        this.otp=_otp;
        this.token=_token;
        this.otpCreatedAt =_otpCreatedAt;
        this.tokenCreatedAt = _tokenCreatedAt;
        this.user = _user;
    }

    private static generateOtp = () =>{
        return Math.floor(100000 + Math.random() * 900000).toString();
      }
    public getAuth = ()=>{
        return {
            id:this.id,
            otp:this.otp,
            token:this.token,
            otpCreatedAt:this.otpCreatedAt,
            tokenCreatedAt: this.tokenCreatedAt,
            user:this.user
        }
    };

    public static sendOtp = (_email:string)=>{
        const generatedOtp =  this.generateOtp();
        const otpId = uuidv4();
    const otpCreatedAt = new Date();
    }



}