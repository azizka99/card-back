import prisma from "../constants/dbConnection";
import isUndefined from "../helpers/isUndefined";
import { validate as isUuid } from "uuid";
import jwt from "jsonwebtoken";
import { signToken, verifyToken } from "../helpers/jwt";

export class User {
    private id: string;
    private name: string;
    private email: string;
    private role: string;
    private password?: string;

    constructor(_id: string, _email: string, _name: string, _role: string, _password?: string) {
        isUndefined(
            { id: _id },
            { email: _email },
            { name: _name },
            { role: _role }
        );

        if (!isUuid(_id)) {
            throw new Error("Invalid UUID format");
        }

        if (_email.length === 0 || _email.length > 255) {
            throw new Error("Email's length should be more than 0 and less than 255");
        }

        if (_name.length === 0 || _name.length > 255) {
            throw new Error("Name's length should be more than 0 and less than 255");
        }

        if (_role !== "client" && _role !== "admin") {
            throw new Error("Role must be either client or admin")
        }


        this.id = _id;
        this.name = _name;
        this.email = _email;
        this.role = _role
        if (_password) {
            this.password = _password;
        }
    };

    public getUser = () => {
        return {
            id: this.id,
            email: this.email,
            name: this.name,
            role: this.role,
            password: this.password
        };
    };

    public static findUserByEmail = async (_email: string) => {
        const _user = await prisma.app_user.findUnique({
            where: {
                email: _email,
                role: "client"
            }
        });

        if (!_user) {
            throw new Error("There is no such user with that email")
        };


        return new User(_user.id as string, _user.email as string, _user.name, _user.role as string, _user.password as string);
    }

    public static signInUser(userid: string) {
        return signToken(userid);
    }

    public static verifyUser(token: string) {
        return verifyToken(token);
    }

}

